// GitHub webhooks. Every delivery must carry a valid X-Hub-Signature-256
// (HMAC over the raw body); deliveries are de-duplicated by X-GitHub-Delivery
// (GitHub retries and manual redeliveries reuse the id), and job creation is
// additionally idempotent per (delivery, project).
import { validateConfig } from "@verifycloud/shared";
import type { FastifyInstance } from "fastify";

import type { Ctx } from "../app.js";
import { tx } from "../db.js";
import { AppError, E } from "../errors.js";

export async function webhookRoutes(api: FastifyInstance, ctx: Ctx) {
  await api.register(async (r) => {
    r.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    r.post("/webhooks/github", { schema: { tags: ["github"], summary: "GitHub App webhook receiver (signature required)" } }, async (req, reply) => {
      const { db, github, metrics, scheduler, notifier, cfg } = ctx;
      if (!github.configured) throw E.unavailable("GitHub integration is not configured");
      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw) || !github.verifySignature(raw, req.headers["x-hub-signature-256"] as string | undefined)) {
        metrics.webhooks.inc({ provider: "github", result: "bad_signature" });
        throw new AppError(401, "INVALID_SIGNATURE", "webhook signature verification failed");
      }
      const event = String(req.headers["x-github-event"] ?? "");
      const delivery = String(req.headers["x-github-delivery"] ?? "");
      if (!/^[A-Za-z0-9-]{8,100}$/.test(delivery)) throw E.badRequest("missing X-GitHub-Delivery");
      // A delivery is processed once. A redelivery of one whose processing
      // failed (status 'error') or never finished (the process died; still
      // 'received' after 60 s) is processed again instead of being dropped
      // as a duplicate (audit G1); job creation is idempotent per
      // (delivery, project), so this cannot create a second job.
      const ins = await db.query(
        `INSERT INTO webhook_deliveries (provider, delivery_id, event, status) VALUES ('github', $1, $2, 'received')
         ON CONFLICT (provider, delivery_id) DO UPDATE SET status = 'received', received_at = now()
          WHERE webhook_deliveries.status = 'error' OR (webhook_deliveries.status = 'received' AND webhook_deliveries.received_at < now() - interval '60 seconds')
         RETURNING delivery_id`,
        [delivery, event],
      );
      if (!ins.rows[0]) {
        metrics.webhooks.inc({ provider: "github", result: "duplicate" });
        return reply.status(200).send({ ok: true, duplicate: true });
      }
      try {
        let payload: any;
        try {
          payload = JSON.parse(raw.toString("utf8"));
        } catch {
          throw E.badRequest("invalid JSON");
        }
        const done = async (status: string, detail: Record<string, unknown> = {}) => {
          await db.query("UPDATE webhook_deliveries SET status = $2, detail = $3 WHERE provider = 'github' AND delivery_id = $1", [delivery, status, JSON.stringify(detail)]);
          metrics.webhooks.inc({ provider: "github", result: status });
          return { ok: true, status, ...detail };
        };

        if (event === "ping") return done("ping");
        if (event === "installation") {
          const inst = payload.installation;
          if (payload.action === "created")
            await db.query(
              "INSERT INTO github_installations (installation_id, account_login, sender_login, sender_id) VALUES ($1,$2,$3,$4) ON CONFLICT (installation_id) DO UPDATE SET removed_at = NULL, sender_login = EXCLUDED.sender_login, sender_id = EXCLUDED.sender_id",
              [inst.id, inst.account?.login ?? "?", payload.sender?.login ?? null, Number.isSafeInteger(payload.sender?.id) ? payload.sender.id : null],
            );
          if (payload.action === "deleted") await db.query("UPDATE github_installations SET removed_at = now() WHERE installation_id = $1", [inst.id]);
          return done("installation", { action: payload.action });
        }

        let ref: { sha: string; branch: string; pr: number | null; trigger: "push" | "pull_request" } | null = null;
        if (event === "push" && payload.ref?.startsWith("refs/heads/") && !payload.deleted && /^[0-9a-f]{40}$/.test(payload.after ?? ""))
          ref = { sha: payload.after, branch: payload.ref.slice("refs/heads/".length), pr: null, trigger: "push" };
        if (event === "pull_request" && ["opened", "synchronize", "reopened"].includes(payload.action))
          ref = { sha: payload.pull_request.head.sha, branch: payload.pull_request.head.ref, pr: payload.pull_request.number, trigger: "pull_request" };
        if (!ref) return done("ignored", { event, action: payload.action });

        const repoName = String(payload.repository?.full_name ?? "");
        const installationId = Number(payload.installation?.id);
        // projects connected to this repository through this (claimed) installation
        const projects = (
          await db.query(
            `SELECT p.*, r.full_name, r.default_branch, r.installation_id FROM projects p JOIN repositories r ON r.id = p.repository_id
               JOIN github_installations gi ON gi.installation_id = r.installation_id AND gi.org_id = p.org_id
              WHERE lower(r.full_name) = lower($1) AND r.installation_id = $2 AND p.state = 'active'`,
            [repoName, installationId],
          )
        ).rows;
        const jobs: string[] = [];
        for (const p of projects) {
          if (ref.trigger === "push" && ref.branch !== (p.branch ?? p.default_branch)) continue;
          if (ref.trigger === "pull_request" && !p.pr_checks) continue;
          const src = { type: "github" as const, repository: p.full_name, installationId, sha: ref.sha };
          const idem = `gh:${delivery}:${p.id}`;
          let configText: string | null = null;
          let configError: string | null = null;
          try {
            configText = await github.getFile(installationId, p.full_name, p.config_path, ref.sha);
            if (!configText) configError = `${p.config_path} not found at ${ref.sha.slice(0, 12)}`;
          } catch (e) {
            configError = `could not read ${p.config_path} from GitHub: ${(e as Error).message}`;
          }
          const v = configText ? validateConfig(configText) : null;
          if (v && !v.ok) configError = `invalid ${p.config_path}: ${v.issues.slice(0, 5).map((i) => `${i.line ? `line ${i.line}: ` : ""}${i.path}: ${i.message}`).join("; ")}`;
          const regression = v?.ok ? (v.config.regressions[ref.trigger === "pull_request" ? "pr" : "push"] ? (ref.trigger === "pull_request" ? "pr" : "push") : v.config.regressions.default ? "default" : Object.keys(v.config.regressions)[0]!) : "default";
          const job = configError
            ? await scheduler.createFailedJob({ orgId: p.org_id, projectId: p.id, regression, trigger: ref.trigger, source: src, commitSha: ref.sha, branch: ref.branch, prNumber: ref.pr, error: configError, idempotencyKey: idem })
            : (await scheduler.createJob({ orgId: p.org_id, projectId: p.id, regression, trigger: ref.trigger, source: src, config: (v as any).config, configText: configText!, commitSha: ref.sha, branch: ref.branch, prNumber: ref.pr, idempotencyKey: idem })).job;
          jobs.push(job.id);
          // A new head on a pull request makes earlier runs of the same PR
          // obsolete: cancel them (their check runs complete as "cancelled"
          // through the normal post-job path). Audit 2026-10-14, O5.
          if (ref.trigger === "pull_request" && ref.pr !== null) {
            const superseded = await db.query(
              `SELECT id FROM jobs WHERE project_id = $1 AND trigger = 'pull_request' AND pr_number = $2 AND commit_sha <> $3
                  AND id <> $4 AND state IN ('QUEUED','RUNNING') AND NOT cancel_requested`,
              [p.id, ref.pr, ref.sha, job.id],
            );
            for (const old of superseded.rows) {
              await db.query("UPDATE jobs SET error = coalesce(error, $2) WHERE id = $1", [old.id, `superseded by ${ref.sha.slice(0, 12)}`]);
              await scheduler.cancel(old.id);
              metrics.webhooks.inc({ provider: "github", result: "superseded_cancelled" });
            }
          }
          const url = `${cfg.publicUrl}/projects/${p.id}/runs/${job.id}`;
          await tx(db, async (c) => {
            await notifier.enqueue(c, p.org_id, "github_check", configError ? "job_failed_to_start" : "job_queued", {
              jobId: job.id, installationId, repo: p.full_name, sha: ref!.sha,
              run: configError
                ? { status: "completed", conclusion: "failure", title: "VerifyCloud configuration error", summary: configError, detailsUrl: url }
                : { status: "queued", title: `Regression ${regression} queued`, summary: `VerifyCloud job #${job.number} (${regression}) is queued.`, detailsUrl: url },
            });
            await notifier.enqueue(c, p.org_id, "github_status", "job_queued", {
              installationId, repo: p.full_name, sha: ref!.sha, state: configError ? "error" : "pending",
              description: configError ? configError.slice(0, 120) : `Regression ${regression} queued`, targetUrl: url,
            });
          });
        }
        return done(jobs.length ? "jobs_created" : "no_matching_project", { jobs });
      } catch (e) {
        await db.query("UPDATE webhook_deliveries SET status = 'error', detail = $2 WHERE provider = 'github' AND delivery_id = $1", [delivery, JSON.stringify({ error: (e as Error).message.slice(0, 300) })]).catch(() => {});
        throw e;
      }
    });
  });
}
