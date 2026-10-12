// Internal worker API (/internal/v1). Workers never get database or storage
// credentials; they authenticate with a worker token and can only act on
// tasks they hold a valid lease for (lease token = fencing token).
// Expose this prefix only on the internal network (docs/deployment.md).
import { randomUUID } from "node:crypto";

import { Type as T } from "@sinclair/typebox";
import { TERMINAL_TASK_STATES } from "@verifycloud/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { Ctx } from "../app.js";
import { storeArtifact, type ArtifactKind } from "../artifacts.js";
import { newToken, safeEqual, sha256 } from "../crypto.js";
import { AppError, E } from "../errors.js";
import type { TaskReport } from "../scheduler.js";

declare module "fastify" {
  interface FastifyRequest {
    worker?: { id: string; name: string };
  }
}

const Id = T.Object({ id: T.String({ format: "uuid" }) });
const ARTIFACT_KINDS: ArtifactKind[] = ["log", "waveform", "waveform_index", "coverage", "model", "source", "report"];

export async function internalRoutes(r: FastifyInstance, ctx: Ctx) {
  const { db, scheduler, cfg } = ctx;
  const metrics = ctx.metrics;
  let uploadsInFlight = 0;
  let uploadBytesInFlight = 0;

  r.post(
    "/workers/register",
    {
      schema: {
        hide: true,
        body: T.Object({ name: T.String({ maxLength: 100 }), version: T.String({ maxLength: 50 }), sandbox: T.String({ maxLength: 20 }), cpus: T.Integer({ minimum: 1, maximum: 1024 }), memoryMb: T.Integer({ minimum: 256 }), toolchain: T.Record(T.String(), T.Unknown()) }),
      },
    },
    async (req) => {
      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), cfg.workerRegistrationToken)) throw E.unauthenticated();
      const b = req.body as { name: string; version: string; sandbox: string; cpus: number; memoryMb: number; toolchain: Record<string, unknown> };
      if (cfg.publicDemo && b.sandbox !== "docker") throw E.forbidden("public demo mode requires the docker sandbox");
      const { token, hash } = newToken("wrk");
      const id = randomUUID();
      await db.query("INSERT INTO workers (id, name, token_hash, version, sandbox, cpus, memory_mb, toolchain) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
        id, b.name, hash, b.version, b.sandbox, b.cpus, b.memoryMb, JSON.stringify(b.toolchain),
      ]);
      ctx.log.info({ worker: id, name: b.name, sandbox: b.sandbox }, "worker registered");
      return { workerId: id, token, leaseSeconds: cfg.limits.leaseSeconds };
    },
  );

  // every other internal route requires a worker token
  const authWorker = async (req: FastifyRequest) => {
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer vc_wrk_")) throw E.unauthenticated();
    const w = (await db.query("SELECT id, name, state FROM workers WHERE token_hash = $1", [sha256(auth.slice(7))])).rows[0];
    if (!w) throw E.unauthenticated();
    // An offline worker (no heartbeat for 2 minutes, e.g. during an API or
    // database outage) must re-register: its leases were reclaimed. A distinct
    // code tells the worker to do so instead of failing forever (audit H1).
    if (w.state === "offline") throw new AppError(401, "WORKER_REREGISTER", "this worker was marked offline; register again");
    req.worker = w;
  };

  await r.register(async (w) => {
    w.addHook("preHandler", authWorker);

    w.post("/workers/heartbeat", { schema: { hide: true, body: T.Object({ running: T.Integer({ minimum: 0 }), draining: T.Optional(T.Boolean()) }) } }, async (req) => {
      const b = req.body as { running: number; draining?: boolean };
      await db.query("UPDATE workers SET last_heartbeat_at = now(), state = $2 WHERE id = $1", [req.worker!.id, b.draining ? "draining" : "online"]);
      ctx.metrics.workerHeartbeats.inc();
      return { ok: true };
    });

    w.post("/tasks/claim", { schema: { hide: true, body: T.Object({ cpu: T.Integer({ minimum: 1 }), memoryMb: T.Integer({ minimum: 1 }) }) } }, async (req) => {
      const b = req.body as { cpu: number; memoryMb: number };
      const claimed = await scheduler.claim(req.worker!.id, { cpu: b.cpu, memoryMb: b.memoryMb });
      if (!claimed) return { task: null };
      const { task, job } = claimed;
      const patch = job.patch_id ? (await db.query("SELECT diff FROM patches WHERE id = $1", [job.patch_id])).rows[0]?.diff ?? null : null;
      return {
        task: {
          id: task.id, kind: task.kind, attempt: task.attempt, testName: task.test_name, seed: task.seed === null ? null : Number(task.seed), plusargs: task.plusargs,
          cpu: task.cpu, memoryMb: task.memory_mb, timeoutSeconds: task.timeout_seconds, modelArtifactId: task.model_artifact_id,
        },
        leaseToken: task.lease_token,
        leaseSeconds: cfg.limits.leaseSeconds,
        job: { id: job.id, orgId: job.org_id, projectId: job.project_id, number: job.number, regression: job.regression, config: job.config, source: job.source, patch, commitSha: job.commit_sha },
      };
    });

    const lease = (req: FastifyRequest) => {
      const l = (req.headers["x-lease-token"] ?? (req.query as Record<string, string>)?.lease) as string | undefined;
      if (!l || !/^[0-9a-f-]{36}$/.test(l)) throw E.badRequest("missing lease token");
      return l;
    };

    w.post("/tasks/:id/heartbeat", { schema: { hide: true, params: Id } }, async (req) => {
      return scheduler.heartbeat((req.params as { id: string }).id, req.worker!.id, lease(req));
    });

    w.get("/tasks/:id/git-credentials", { schema: { hide: true, params: Id } }, async (req) => {
      const t = await scheduler.checkLeaseExternal((req.params as { id: string }).id, req.worker!.id, lease(req));
      if (t.kind !== "build") throw E.forbidden("only builds fetch sources");
      const job = (await db.query("SELECT source FROM jobs WHERE id = $1", [t.job_id])).rows[0];
      const src = job.source;
      if (src.type !== "github") throw E.badRequest("job source is not a repository");
      const token = await ctx.github.installationToken(src.installationId, src.repository);
      const base = process.env.GITHUB_CLONE_BASE ?? "https://github.com";
      return { cloneUrl: `${base.replace(/\/$/, "")}/${src.repository}.git`, sha: src.sha, username: "x-access-token", token };
    });

    w.get("/tasks/:id/cache/:key", { schema: { hide: true, params: T.Object({ id: T.String({ format: "uuid" }), key: T.String({ pattern: "^[0-9a-f]{64}$" }) }) } }, async (req) => {
      const { id, key } = req.params as { id: string; key: string };
      const t = await scheduler.checkLeaseExternal(id, req.worker!.id, lease(req));
      const r = await db.query(
        "UPDATE build_cache SET hits = hits + 1, last_used_at = now() WHERE org_id = $1 AND cache_key = $2 AND EXISTS (SELECT 1 FROM artifacts WHERE id = build_cache.artifact_id) RETURNING artifact_id",
        [t.org_id, key],
      );
      ctx.metrics.buildCache.inc({ result: r.rows[0] ? "hit" : "miss" });
      return { hit: Boolean(r.rows[0]), artifactId: r.rows[0]?.artifact_id ?? null };
    });

    w.get("/tasks/:id/artifacts/:artifactId", { schema: { hide: true, params: T.Object({ id: T.String({ format: "uuid" }), artifactId: T.String({ format: "uuid" }) }) } }, async (req, reply) => {
      const { id, artifactId } = req.params as { id: string; artifactId: string };
      const t = await scheduler.checkLeaseExternal(id, req.worker!.id, lease(req));
      // only source/model artifacts of the same organization
      const a = (await db.query("SELECT * FROM artifacts WHERE id = $1 AND org_id = $2 AND kind IN ('source','model')", [artifactId, t.org_id])).rows[0];
      if (!a) throw E.notFound("artifact");
      const obj = await ctx.store.get(a.storage_key);
      reply.header("Content-Type", "application/octet-stream");
      reply.header("Content-Length", String(a.size_bytes));
      reply.header("X-Content-SHA256", a.sha256);
      return reply.send(obj.body);
    });

    w.post(
      "/tasks/:id/artifacts",
      {
        schema: {
          hide: true,
          params: Id,
          querystring: T.Object({ kind: T.String(), name: T.String({ maxLength: 100 }), contentType: T.String({ maxLength: 100 }), encoding: T.Optional(T.Literal("gzip")), meta: T.Optional(T.String({ maxLength: 4000 })) }),
        },
        bodyLimit: cfg.limits.maxArtifactBytes,
        // Uploads are buffered in memory (then hashed and stored). Without a
        // bound, a few concurrent maximum-size uploads exhaust the API's
        // memory (audit S13). Over budget → 503 + Retry-After; the worker
        // retries 503 for two minutes. One upload is always admitted.
        onRequest: (req, reply, done) => {
          const len = Number(req.headers["content-length"]);
          if (!Number.isSafeInteger(len) || len < 0) return void reply.status(411).send({ error: { code: "LENGTH_REQUIRED", message: "artifact uploads need a Content-Length" } });
          if (uploadsInFlight > 0 && uploadBytesInFlight + len > cfg.limits.uploadMemoryBudgetBytes) {
            metrics.uploadsRejected.inc();
            return void reply.status(503).header("Retry-After", "5").send({ error: { code: "UPLOAD_BUSY", message: "too many artifact bytes in flight; retry" } });
          }
          uploadsInFlight++;
          uploadBytesInFlight += len;
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            uploadsInFlight--;
            uploadBytesInFlight -= len;
          };
          req.raw.once("close", release);
          reply.raw.once("close", release);
          done();
        },
      },
      async (req, reply) => {
        const t = await scheduler.checkLeaseExternal((req.params as { id: string }).id, req.worker!.id, lease(req));
        const q = req.query as { kind: string; name: string; contentType: string; encoding?: "gzip"; meta?: string };
        if (!ARTIFACT_KINDS.includes(q.kind as ArtifactKind)) throw E.badRequest("invalid artifact kind");
        if (!Buffer.isBuffer(req.body)) throw E.badRequest("send the artifact as application/octet-stream");
        let meta: Record<string, unknown> = {};
        try {
          meta = q.meta ? JSON.parse(q.meta) : {};
        } catch {
          throw E.badRequest("meta must be JSON");
        }
        const a = await storeArtifact(ctx, { orgId: t.org_id, projectId: t.project_id, jobId: t.job_id, taskId: t.id, kind: q.kind as ArtifactKind, name: q.name, contentType: q.contentType, encoding: q.encoding ?? null, body: req.body, metadata: meta, lease: { taskId: t.id, workerId: req.worker!.id, token: lease(req) } });
        return reply.status(201).send({ id: a.id });
      },
    );

    w.post("/tasks/:id/complete", { schema: { hide: true, params: Id, body: T.Object({ report: T.Record(T.String(), T.Unknown()) }) } }, async (req) => {
      const rep = (req.body as { report: TaskReport }).report;
      const states = ["PASSED", "FAILED", "ERROR", "TIMED_OUT", "RESOURCE_EXCEEDED", "CANCELLED"];
      if (!states.includes(rep.state)) throw E.badRequest("invalid state");
      // artifacts referenced in the report must belong to this task's organization
      const id = (req.params as { id: string }).id;
      // a retried report for an already recorded outcome goes straight to the
      // idempotent path in complete() (audit M5)
      const prior = (await db.query("SELECT state, lease_token FROM tasks WHERE id = $1", [id])).rows[0];
      if (prior && prior.lease_token === lease(req) && (TERMINAL_TASK_STATES as string[]).includes(prior.state)) return scheduler.complete(id, req.worker!.id, lease(req), rep);
      const t = await scheduler.checkLeaseExternal(id, req.worker!.id, lease(req));
      for (const aid of [rep.modelArtifactId, rep.sourceArtifactId, rep.coverage?.detailArtifactId].filter(Boolean))
        if (!(await db.query("SELECT 1 FROM artifacts WHERE id = $1 AND org_id = $2", [aid, t.org_id])).rows[0]) throw E.badRequest("report references an unknown artifact");
      return scheduler.complete(id, req.worker!.id, lease(req), rep);
    });
  });
}
