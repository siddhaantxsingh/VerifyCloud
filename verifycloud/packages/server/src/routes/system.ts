// Health, readiness, metrics, worker overview, public demo login.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { FastifyInstance } from "fastify";

import { loadJob, requirePrincipal, setSessionCookie } from "../access.js";
import type { Ctx } from "../app.js";
import { safeEqual } from "../crypto.js";
import { E } from "../errors.js";
import { fixedWindow } from "../ratelimit.js";
import { createSession } from "./auth.js";

export async function systemRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, store, cfg } = ctx;

  app.get("/health", { schema: { hide: true } }, async () => ({ status: "ok" }));

  app.get("/ready", { schema: { hide: true } }, async (_req, reply) => {
    const checks: Record<string, boolean> = { database: false, objectStorage: false };
    try {
      await db.query("SELECT 1 FROM schema_migrations LIMIT 1");
      checks.database = true;
    } catch {
      /* not ready */
    }
    try {
      await store.ping();
      checks.objectStorage = true;
    } catch {
      /* not ready */
    }
    const ok = Object.values(checks).every(Boolean);
    return reply.status(ok ? 200 : 503).send({ status: ok ? "ready" : "not_ready", checks });
  });

  app.get("/metrics", { schema: { hide: true } }, async (req, reply) => {
    const token = process.env.METRICS_TOKEN;
    const auth = req.headers.authorization ?? "";
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
    if (token ? !(auth.startsWith("Bearer ") && safeEqual(auth.slice(7), token)) : !local) throw E.notFound("route");
    reply.header("Content-Type", "text/plain; version=0.0.4");
    return ctx.metrics.render();
  });

  app.get("/api/v1/workers", { schema: { tags: ["workers"], summary: "Worker pool status" } }, async (req) => {
    const p = requirePrincipal(req);
    const admin = p.kind === "user" && p.platformAdmin;
    const r = await db.query(
      `SELECT w.id, w.name, w.version, w.sandbox, w.cpus, w.memory_mb, w.toolchain, w.state, w.registered_at, w.last_heartbeat_at,
              (SELECT count(*)::int FROM tasks t WHERE t.lease_worker = w.id AND t.state = 'RUNNING') AS running
         FROM workers w WHERE w.last_heartbeat_at > now() - interval '1 day' ORDER BY w.last_heartbeat_at DESC LIMIT 200`,
    );
    const queue = (await db.query("SELECT count(*)::int AS n FROM tasks WHERE state = 'QUEUED'")).rows[0].n;
    const online = r.rows.filter((w) => Date.now() - Date.parse(w.last_heartbeat_at) < 60_000);
    return {
      online: online.length,
      capacityCpus: online.reduce((s, w) => s + w.cpus, 0),
      running: online.reduce((s, w) => s + w.running, 0),
      queueDepth: queue,
      // only platform admins see individual workers (infrastructure detail)
      workers: admin ? r.rows : undefined,
    };
  });

  // Public demo: an ephemeral account in the demo organization. Demo users
  // can run the pre-approved demo project only (uploads, patches and new
  // projects are refused in demo mode; see docs/security.md).
  app.post("/api/v1/auth/demo", { schema: { tags: ["auth"], summary: "Start a public demo session (only when PUBLIC_DEMO=true)" } }, async (req, reply) => {
    if (!cfg.publicDemo) throw E.notFound("route");
    const rl = await fixedWindow(db, `demo:${req.ip}`, 5, 3600);
    if (!rl.ok) throw E.rateLimited(rl.retryAfter);
    const org = (await db.query("SELECT id FROM organizations WHERE is_demo ORDER BY created_at LIMIT 1")).rows[0];
    if (!org) throw E.unavailable("demo is not set up");
    const id = randomUUID();
    await db.query("INSERT INTO users (id, email, name, email_verified_at) VALUES ($1,$2,'Demo user', now())", [id, `demo-${randomBytes(6).toString("hex")}@demo.invalid`]);
    await db.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,'engineer')", [org.id, id]);
    setSessionCookie(reply, await createSession({ ...ctx, cfg: { ...cfg, sessionTtlHours: 2 } }, req, id), 2, cfg.cookieSecure);
    return { ok: true, orgId: org.id };
  });

  // Demo-only: register the shipped reference fix as a pre-approved patch for a demo job.
  app.post("/api/v1/jobs/:id/demo-patch", { schema: { tags: ["ai"], summary: "Demo organizations only: attach the shipped reference fix as a patch" } }, async (req, reply) => {
    const p = requirePrincipal(req);
    const id = (req.params as { id: string }).id;
    const { row } = await loadJob(db, p, id, "engineer");
    const org = (await db.query("SELECT is_demo FROM organizations WHERE id = $1", [row.org_id])).rows[0];
    const file = process.env.DEMO_PATCH_FILE;
    if (!org.is_demo || !file) throw E.notFound("route");
    const diff = readFileSync(file, "utf8");
    const { files } = await ctx.ai.checkPatch(row.id, diff);
    const pid = randomUUID();
    await db.query("INSERT INTO patches (id, org_id, project_id, job_id, origin, diff, files, created_by) VALUES ($1,$2,$3,$4,'user',$5,$6,NULL)", [pid, row.org_id, row.project_id, row.id, diff, files]);
    return reply.status(201).send({ patch: (await db.query("SELECT * FROM patches WHERE id = $1", [pid])).rows[0] });
  });
}
