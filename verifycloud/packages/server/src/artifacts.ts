// Storing artifacts: quota check, object upload, metadata row with an expiry
// derived from the project's retention policy (bounded by the plan).
import { randomUUID } from "node:crypto";

import type { Ctx } from "./app.js";
import { sha256hex } from "./crypto.js";
import type { Q } from "./db.js";
import { E } from "./errors.js";
import { objectKey } from "./storage.js";

export type ArtifactKind = "log" | "waveform" | "waveform_index" | "coverage" | "model" | "source" | "report" | "patch";
const RETENTION_CLASS: Record<ArtifactKind, string> = {
  log: "logs", report: "logs", waveform: "waveforms", waveform_index: "waveforms", coverage: "coverage", model: "models", source: "sources", patch: "sources",
};

export interface NewArtifact {
  orgId: string;
  projectId: string | null;
  jobId: string | null;
  taskId: string | null;
  kind: ArtifactKind;
  name: string;
  contentType: string;
  encoding?: "gzip" | null;
  body: Buffer;
  metadata?: Record<string, unknown>;
  /** Uploads from workers: the row is only inserted while this lease is still held (checked atomically with the insert). */
  lease?: { taskId: string; workerId: string; token: string };
}

export async function orgStorageUsage(q: Q, orgId: string): Promise<{ used: number; quota: number }> {
  const r = await q.query(
    "SELECT coalesce((SELECT sum(size_bytes) FROM artifacts WHERE org_id = $1), 0)::bigint AS used, pl.artifact_quota_bytes AS quota FROM organizations o JOIN plans pl ON pl.name = o.plan WHERE o.id = $1",
    [orgId],
  );
  return { used: Number(r.rows[0].used), quota: Number(r.rows[0].quota) };
}

export async function retentionDays(q: Q, projectId: string | null, kind: ArtifactKind): Promise<number> {
  const cls = RETENTION_CLASS[kind];
  if (!projectId) return 30;
  const r = await q.query("SELECT p.retention, pl.max_retention_days FROM projects p JOIN organizations o ON o.id = p.org_id JOIN plans pl ON pl.name = o.plan WHERE p.id = $1", [projectId]);
  const row = r.rows[0];
  if (!row) return 30;
  const want = Number(row.retention?.[cls] ?? 30);
  const max = Number(row.max_retention_days?.[cls] ?? 30);
  return Math.max(1, Math.min(want, max));
}

export async function storeArtifact(ctx: Ctx, a: NewArtifact): Promise<{ id: string; storageKey: string; size: number }> {
  if (a.body.length > ctx.cfg.limits.maxArtifactBytes) throw E.tooLarge(`artifact larger than ${ctx.cfg.limits.maxArtifactBytes} bytes`);
  const { used, quota } = await orgStorageUsage(ctx.db, a.orgId);
  if (used + a.body.length > quota) {
    if (a.projectId)
      await ctx.notifier
        .notifyProject(ctx.db, a.orgId, a.projectId, "quota_exceeded", { subject: "VerifyCloud: artifact storage quota exceeded", text: `Storage used ${used} of ${quota} bytes.` })
        .catch(() => {});
    throw E.quota("artifact storage quota of the organization exceeded", { used, quota });
  }
  const id = randomUUID();
  const key = objectKey(a.orgId, id, a.name);
  await ctx.store.put(key, a.body, a.contentType, a.encoding ?? undefined);
  const days = await retentionDays(ctx.db, a.projectId, a.kind);
  try {
    // The lease is re-checked in the INSERT itself: an upload that started
    // under a valid lease but finished after the task was reclaimed must not
    // attach a stale attempt's artifact (audit 2026-10-08, M6).
    const params: unknown[] = [id, a.orgId, a.projectId, a.jobId, a.taskId, a.kind, a.name, a.contentType, a.encoding ?? null, a.body.length, sha256hex(a.body), key, JSON.stringify(a.metadata ?? {}), days];
    let guard = "";
    if (a.lease) {
      params.push(a.lease.taskId, a.lease.workerId, a.lease.token);
      guard = "WHERE EXISTS (SELECT 1 FROM tasks WHERE id = $15 AND lease_worker = $16 AND lease_token = $17 AND state = 'RUNNING')";
    }
    const ins = await ctx.db.query(
      `INSERT INTO artifacts (id, org_id, project_id, job_id, task_id, kind, name, content_type, encoding, size_bytes, sha256, storage_key, metadata, expires_at)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now() + make_interval(days => $14) ${guard}`,
      params,
    );
    if (ins.rowCount === 0) throw E.conflict("LEASE_LOST", "the lease on this task is no longer held by this worker");
  } catch (e) {
    await ctx.store.delete(key).catch(() => {}); // do not leave an unreferenced object behind
    throw e;
  }
  ctx.metrics.artifactBytes.inc({ kind: a.kind }, a.body.length);
  await ctx.db
    .query("INSERT INTO usage_records (org_id, project_id, job_id, kind, quantity, source_key) VALUES ($1,$2,$3,'artifact_bytes',$4,$5) ON CONFLICT DO NOTHING", [
      a.orgId, a.projectId, a.jobId, a.body.length, `artifact:${id}`,
    ])
    .catch(() => {});
  return { id, storageKey: key, size: a.body.length };
}
