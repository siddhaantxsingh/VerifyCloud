// Artifacts: listing, metadata, downloads (with HTTP Range), waveform queries.
// Large artifacts are streamed from object storage; nothing big is ever
// embedded in JSON responses. Every access is authorized against the
// artifact's organization (no direct object URLs are handed out).
import { Type as T } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";

import { loadArtifact, loadProject, requirePrincipal } from "../access.js";
import type { Ctx } from "../app.js";
import { audit } from "../audit.js";
import { E } from "../errors.js";
import { loadWaveIndex, searchSignals, signalValues } from "../waveform.js";

const Id = T.Object({ id: T.String({ format: "uuid" }) });

export async function artifactRoutes(api: FastifyInstance, ctx: Ctx) {
  const { db, store } = ctx;

  api.get(
    "/projects/:id/artifacts",
    { schema: { tags: ["artifacts"], summary: "List artifacts", params: Id, querystring: T.Object({ kind: T.Optional(T.String({ maxLength: 20 })), job: T.Optional(T.String({ format: "uuid" })), before: T.Optional(T.String({ format: "date-time" })), limit: T.Optional(T.Integer({ minimum: 1, maximum: 200 })) }) } },
    async (req) => {
      const { row } = await loadProject(db, requirePrincipal(req), (req.params as { id: string }).id);
      const q = req.query as { kind?: string; job?: string; before?: string; limit?: number };
      const params: unknown[] = [row.id];
      const conds = ["a.project_id = $1"];
      if (q.kind) conds.push(`a.kind = $${params.push(q.kind)}`);
      if (q.job) conds.push(`a.job_id = $${params.push(q.job)}`);
      if (q.before) conds.push(`a.created_at < $${params.push(q.before)}`);
      const limit = q.limit ?? 50;
      const r = await db.query(
        `SELECT a.id, a.kind, a.name, a.content_type, a.encoding, a.size_bytes, a.sha256, a.expires_at, a.created_at, a.job_id, a.task_id, j.number AS job_number, t.test_name, t.seed
           FROM artifacts a LEFT JOIN jobs j ON j.id = a.job_id LEFT JOIN tasks t ON t.id = a.task_id
          WHERE ${conds.join(" AND ")} ORDER BY a.created_at DESC LIMIT ${limit}`,
        params,
      );
      const total = (await db.query("SELECT count(*)::int AS n, coalesce(sum(size_bytes), 0)::bigint AS bytes FROM artifacts WHERE project_id = $1", [row.id])).rows[0];
      return { artifacts: r.rows, total: { count: total.n, bytes: Number(total.bytes) }, nextBefore: r.rows.length === limit ? r.rows[r.rows.length - 1].created_at : null };
    },
  );

  api.get("/artifacts/:id", { schema: { tags: ["artifacts"], summary: "Artifact metadata", params: Id } }, async (req) => {
    const { row } = await loadArtifact(db, requirePrincipal(req), (req.params as { id: string }).id);
    const { storage_key: _k, ...meta } = row as Record<string, unknown>;
    return { artifact: meta };
  });

  api.get(
    "/artifacts/:id/download",
    { schema: { tags: ["artifacts"], summary: "Download (supports Range). Compressed artifacts are served as stored (gzip), with a .gz file name", params: Id } },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const { row } = await loadArtifact(db, p, (req.params as { id: string }).id);
      const size = Number(row.size_bytes);
      let range: { start: number; end?: number } | undefined;
      const h = req.headers.range;
      if (h) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(h);
        if (!m) throw E.badRequest("unsupported Range header");
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        if (start >= size || start > end) return reply.status(416).header("Content-Range", `bytes */${size}`).send();
        range = { start, end };
      }
      const obj = await store.get(row.storage_key as string, range);
      const base = String(row.name).replace(/[^A-Za-z0-9._-]/g, "_");
      const name = row.encoding === "gzip" && !base.endsWith(".gz") ? `${base}.gz` : base;
      reply.header("Content-Type", row.encoding === "gzip" ? "application/gzip" : String(row.content_type));
      reply.header("Content-Disposition", `attachment; filename="${name}"`);
      reply.header("Accept-Ranges", "bytes");
      reply.header("X-Content-SHA256", String(row.sha256));
      if (range) {
        reply.status(206).header("Content-Range", `bytes ${range.start}-${range.end}/${size}`).header("Content-Length", String(range.end! - range.start + 1));
      } else reply.header("Content-Length", String(size));
      if (row.kind === "source" || row.kind === "model")
        await audit(db, req, p, { orgId: row.org_id, action: "artifact.download", targetType: "artifact", targetId: row.id, metadata: { kind: row.kind } });
      return reply.send(obj.body);
    },
  );

  api.delete("/artifacts/:id", { schema: { tags: ["artifacts"], summary: "Delete an artifact (admin); the stored object is deleted by the retention loop", params: Id } }, async (req) => {
    const p = requirePrincipal(req);
    const { row } = await loadArtifact(db, p, (req.params as { id: string }).id, "admin");
    await db.query("DELETE FROM artifacts WHERE id = $1", [row.id]);
    await audit(db, req, p, { orgId: row.org_id, action: "artifact.delete", targetType: "artifact", targetId: row.id });
    return { ok: true };
  });

  // -------------------------------------------------- waveforms
  const waveIndexFor = async (req: import("fastify").FastifyRequest) => {
    const { row } = await loadArtifact(db, requirePrincipal(req), (req.params as { id: string }).id);
    // accept either the waveform artifact or its index
    const idx =
      row.kind === "waveform_index"
        ? row
        : row.kind === "waveform"
          ? (await db.query("SELECT * FROM artifacts WHERE task_id = $1 AND kind = 'waveform_index' AND org_id = $2 LIMIT 1", [row.task_id, row.org_id])).rows[0]
          : null;
    if (!idx) throw E.notFound("waveform index");
    return { w: await loadWaveIndex(ctx, idx.id, idx.storage_key), meta: idx };
  };

  api.get(
    "/artifacts/:id/waveform/signals",
    { schema: { tags: ["waveforms"], summary: "Waveform metadata and signal search", params: Id, querystring: T.Object({ q: T.Optional(T.String({ maxLength: 200 })), limit: T.Optional(T.Integer({ minimum: 1, maximum: 2000 })) }) } },
    async (req) => {
      const { w } = await waveIndexFor(req);
      const q = req.query as { q?: string; limit?: number };
      return { timescale: w.timescale, endTime: w.endTime, clockPeriod: w.clockPeriod, truncated: w.truncated, signalCount: w.signals.length, signals: searchSignals(w, q.q ?? "", q.limit ?? 500) };
    },
  );

  api.get(
    "/artifacts/:id/waveform/values",
    {
      schema: {
        tags: ["waveforms"],
        summary: "Value changes of selected signals in a time window (downsampled to maxPoints)",
        params: Id,
        querystring: T.Object({ ids: T.String({ pattern: "^\\d+(,\\d+){0,63}$" }), from: T.Integer({ minimum: 0 }), to: T.Integer({ minimum: 0 }), maxPoints: T.Optional(T.Integer({ minimum: 10, maximum: 5000 })) }),
      },
    },
    async (req) => {
      const { w } = await waveIndexFor(req);
      const q = req.query as { ids: string; from: number; to: number; maxPoints?: number };
      if (q.to < q.from) throw E.validation("to must be >= from");
      return { timescale: w.timescale, from: q.from, to: q.to, signals: signalValues(w, q.ids.split(",").map(Number), q.from, q.to, q.maxPoints ?? 1000) };
    },
  );
}
