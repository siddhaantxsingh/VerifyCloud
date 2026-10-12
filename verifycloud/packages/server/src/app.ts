// HTTP application: wiring of configuration, database, storage, scheduler,
// background loops and routes.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

import swagger from "@fastify/swagger";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import { authenticate, checkOrigin } from "./access.js";
import { AiService } from "./ai/service.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { createPool, migrate, type Db } from "./db.js";
import { AppError, E } from "./errors.js";
import { EventHub } from "./events.js";
import { GitHub } from "./github.js";
import { Mailer } from "./mailer.js";
import { Metrics } from "./metrics.js";
import { Notifier } from "./notify.js";
import { postJob } from "./postjob.js";
import { purgeRateLimits, TokenBuckets } from "./ratelimit.js";
import { Retention } from "./retention.js";
import { aiRoutes } from "./routes/ai.js";
import { artifactRoutes } from "./routes/artifacts.js";
import { authRoutes } from "./routes/auth.js";
import { eventRoutes } from "./routes/events.js";
import { internalRoutes } from "./routes/internal.js";
import { jobRoutes } from "./routes/jobs.js";
import { orgRoutes } from "./routes/orgs.js";
import { projectRoutes } from "./routes/projects.js";
import { systemRoutes } from "./routes/system.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { Scheduler } from "./scheduler.js";
import { S3Store, type ObjectStore } from "./storage.js";

export interface Ctx {
  cfg: ServerConfig;
  db: Db;
  store: ObjectStore;
  metrics: Metrics;
  scheduler: Scheduler;
  events: EventHub;
  github: GitHub;
  mailer: Mailer;
  notifier: Notifier;
  ai: AiService;
  retention: Retention;
  log: FastifyInstance["log"];
}

export interface App {
  fastify: FastifyInstance;
  ctx: Ctx;
  listen(): Promise<number>;
  close(): Promise<void>;
}

export async function createApp(overrides: Partial<ServerConfig> = {}, opts: { store?: ObjectStore; background?: boolean } = {}): Promise<App> {
  const cfg = loadConfig(overrides);
  const fastify = Fastify({
    logger: {
      level: cfg.logLevel,
      redact: { paths: ["req.headers.authorization", "req.headers.cookie", "req.headers['x-hub-signature-256']", "res.headers['set-cookie']"], censor: "[REDACTED]" },
      serializers: { req: (r) => ({ method: r.method, url: r.url.replace(/([?&](lease|token)=)[^&]+/g, "$1[REDACTED]"), ip: r.ip }) },
    },
    genReqId: (req) => {
      const h = req.headers["x-request-id"];
      return typeof h === "string" && /^[A-Za-z0-9_.:-]{8,128}$/.test(h) ? h : randomUUID();
    },
    bodyLimit: 1024 * 1024,
    trustProxy: trustProxySetting(process.env.TRUST_PROXY),
    ajv: { customOptions: { removeAdditional: false, allErrors: false, coerceTypes: "array" } },
  });
  const db = createPool(cfg.databaseUrl, (e) => fastify.log.warn({ err: e.message }, "database pool error"));
  await migrate(db);
  const store = opts.store ?? new S3Store(cfg.s3);
  await store.ensureBucket().catch((e) => fastify.log.warn({ err: (e as Error).message }, "object storage not reachable at startup"));
  const metrics = new Metrics();
  const github = new GitHub(cfg, fastify.log);
  const mailer = new Mailer(cfg, fastify.log);
  const events = new EventHub(db, cfg.databaseUrl, fastify.log);
  await events.start();
  const ctx = { cfg, db, store, metrics, github, mailer, events, log: fastify.log } as Ctx;
  ctx.notifier = new Notifier(ctx);
  ctx.retention = new Retention(ctx);
  ctx.ai = new AiService(ctx);
  ctx.scheduler = new Scheduler(db, cfg, metrics, fastify.log, { onJobFinished: (jobId) => postJob(ctx, jobId) });

  // ---------------------------------------------------------------- errors
  fastify.setErrorHandler((err: Error & { validation?: unknown; statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof AppError) {
      if (err.status === 429 && (err.details as { retryAfter?: number })?.retryAfter) reply.header("Retry-After", String((err.details as { retryAfter: number }).retryAfter));
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details, requestId: req.id } });
    }
    if (err.validation) return reply.status(400).send({ error: { code: "VALIDATION_FAILED", message: err.message, requestId: req.id } });
    if (err.statusCode === 413 || err.code === "FST_ERR_CTP_BODY_TOO_LARGE")
      return reply.status(413).send({ error: { code: "PAYLOAD_TOO_LARGE", message: "request body too large", requestId: req.id } });
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500)
      return reply.status(err.statusCode).send({ error: { code: "BAD_REQUEST", message: err.message, requestId: req.id } });
    // dependency outages are reported as 503 so clients (workers, CLI) retry
    if (isDependencyOutage(err)) {
      req.log.warn({ err: err.message }, "dependency unavailable");
      reply.header("Retry-After", "5");
      return reply.status(503).send({ error: { code: "SERVICE_UNAVAILABLE", message: "a backing service is temporarily unavailable; retry", requestId: req.id } });
    }
    req.log.error({ err: err.message, stack: err.stack }, "unhandled error");
    return reply.status(500).send({ error: { code: "INTERNAL", message: "internal error", requestId: req.id } });
  });
  fastify.setNotFoundHandler((req, reply) => {
    if (cfg.serveStatic && req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/internal/")) return serveSpa(cfg.serveStatic, req, reply);
    reply.status(404).send({ error: { code: "ROUTE_NOT_FOUND", message: "no such endpoint", requestId: req.id } });
  });

  // raw bodies for uploads and webhooks
  fastify.addContentTypeParser(["application/gzip", "application/octet-stream", "application/x-tar"], { parseAs: "buffer", bodyLimit: Math.max(cfg.limits.maxUploadBytes, cfg.limits.maxArtifactBytes) }, (_req, body, done) => done(null, body));

  // ---------------------------------------------------------------- per request
  const buckets = new TokenBuckets(cfg.limits.apiRatePerMinute, cfg.limits.apiRatePerMinute);
  fastify.addHook("onRequest", async (req, reply) => {
    reply.header("X-Request-Id", req.id);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    if (!req.url.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    checkOrigin(req, cfg.allowedOrigins, cfg.publicUrl);
    req.principal = await authenticate(db, req);
    // a read-only token (PAT or org key without write/admin scope) never
    // changes anything, whatever the route checks (audit S11)
    const scopes = req.principal ? (req.principal.kind === "org_key" ? req.principal.scopes : req.principal.scopes) : null;
    if (scopes && !["GET", "HEAD", "OPTIONS"].includes(req.method) && !scopes.includes("write") && !scopes.includes("admin"))
      throw E.forbidden("this token is read-only");
    const who = req.principal ? (req.principal.kind === "user" ? `u:${req.principal.userId}` : `k:${req.principal.tokenId}`) : `ip:${req.ip}`;
    if (!buckets.take(who)) {
      metrics.rateLimited.inc({ kind: "api" });
      throw E.rateLimited(10);
    }
  });
  fastify.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url ?? "unmatched";
    metrics.apiRequests.inc({ route, method: req.method, status: String(reply.statusCode) });
    metrics.apiLatency.observe(reply.elapsedTime / 1000, { route });
  });

  // ---------------------------------------------------------------- OpenAPI
  await fastify.register(swagger, {
    openapi: {
      info: { title: "VerifyCloud API", version: "1.0.0", description: "CI/CD, regression testing, coverage, and AI-assisted debugging for RTL. See docs/api.md." },
      servers: [{ url: cfg.publicUrl }],
      components: {
        securitySchemes: {
          bearer: { type: "http", scheme: "bearer", description: "Personal access token (vc_pat_…) or organization API key (vc_key_…)" },
          session: { type: "apiKey", in: "cookie", name: "vc_session" },
        },
      },
      security: [{ bearer: [] }, { session: [] }],
    },
  });

  await fastify.register(async (api) => {
    await authRoutes(api, ctx);
    await orgRoutes(api, ctx);
    await projectRoutes(api, ctx);
    await jobRoutes(api, ctx);
    await artifactRoutes(api, ctx);
    await aiRoutes(api, ctx);
    await eventRoutes(api, ctx);
    await webhookRoutes(api, ctx);
  }, { prefix: "/api/v1" });
  await fastify.register(async (internal) => internalRoutes(internal, ctx), { prefix: "/internal/v1" });
  await systemRoutes(fastify, ctx);
  fastify.get("/api/v1/openapi.json", { schema: { hide: true } }, async () => fastify.swagger());

  // ---------------------------------------------------------------- background loops
  const timers: NodeJS.Timeout[] = [];
  if (opts.background !== false) {
    const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
      let running = false;
      timers.push(
        setInterval(() => {
          if (running) return;
          running = true;
          fn()
            .catch((e) => fastify.log.warn({ err: (e as Error).message, loop: name }, "background loop failed"))
            .finally(() => (running = false));
        }, ms).unref(),
      );
    };
    every(cfg.limits.reaperIntervalMs, "reaper", async () => {
      await ctx.scheduler.reap();
      metrics.queueDepth.set(await ctx.scheduler.queueDepth());
      const r = await db.query(
        "SELECT (SELECT count(*)::int FROM jobs WHERE state = 'RUNNING') AS running, (SELECT count(*)::int FROM workers WHERE last_heartbeat_at > now() - interval '1 minute') AS workers",
      );
      metrics.jobsRunning.set(r.rows[0].running);
      metrics.workersOnline.set(r.rows[0].workers);
    });
    // jobs whose post-processing was lost (API crash right after finalization)
    every(30_000, "post-job sweep", async () => {
      const r = await db.query("SELECT id FROM jobs WHERE post_processed_at IS NULL AND finished_at < now() - interval '60 seconds' ORDER BY finished_at LIMIT 20");
      for (const row of r.rows) await postJob(ctx, row.id);
    });
    every(2_000, "notifications", () => ctx.notifier.deliverPending());
    every(60_000, "retention", () => ctx.retention.run());
    every(15 * 60_000, "housekeeping", async () => {
      await purgeRateLimits(db);
      await db.query("DELETE FROM sessions WHERE expires_at < now()");
      await db.query("DELETE FROM oauth_states WHERE expires_at < now()");
      await db.query("DELETE FROM email_tokens WHERE expires_at < now() - interval '1 day'");
      const pr = await db.query(
        "SELECT count(*) FILTER (WHERE state = 'PASSED')::float / nullif(count(*), 0) AS rate FROM tasks WHERE kind = 'test' AND finished_at > now() - interval '1 hour'",
      );
      if (pr.rows[0].rate !== null) metrics.testPassRate.set(Number(pr.rows[0].rate));
    });
  }

  return {
    fastify,
    ctx,
    async listen() {
      await fastify.listen({ port: cfg.port, host: cfg.host });
      const a = fastify.server.address();
      return typeof a === "object" && a ? a.port : cfg.port;
    },
    async close() {
      timers.forEach(clearInterval);
      await fastify.close();
      await events.stop();
      await db.end();
    },
  };
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };
function serveSpa(dir: string, req: FastifyRequest, reply: import("fastify").FastifyReply) {
  const url = decodeURIComponent(req.url.split("?")[0]!);
  const rel = normalize(url).replace(/^(\.\.[/\\])+/, "");
  let file = join(dir, rel);
  if (!file.startsWith(normalize(dir)) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, "index.html");
  const ext = extname(file);
  reply.header("Content-Type", MIME[ext] ?? "application/octet-stream");
  reply.header("Cache-Control", rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
  if (ext === ".html")
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  reply.header("X-Frame-Options", "DENY");
  return reply.send(readFileSync(file));
}

/** Connection-level failures of PostgreSQL or object storage (not query or permission errors). */
export function isDependencyOutage(err: unknown): boolean {
  const seen = new Set<unknown>();
  let e: any = err;
  while (e && !seen.has(e)) {
    seen.add(e);
    const code = String(e.code ?? e.errno ?? "");
    if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "57P01", "57P02", "57P03", "08000", "08003", "08006", "08001", "08004"].includes(code)) return true;
    if (/Connection terminated|connection timeout|Client has encountered a connection error|timeout exceeded when trying to connect/i.test(String(e.message ?? ""))) return true;
    if (e.$metadata && (e.$metadata.httpStatusCode === undefined || e.$metadata.httpStatusCode >= 500) && e.name !== "NoSuchKey") return true;
    e = e.cause;
  }
  return false;
}

/**
 * TRUST_PROXY: a hop count ("1" = only the nearest proxy), or a comma-separated
 * list of proxy addresses/CIDRs. "true" (trust every hop) would let clients
 * choose their own IP via X-Forwarded-For and defeat per-IP rate limits, so it
 * is mapped to one hop (audit S3).
 */
export function trustProxySetting(v: string | undefined): boolean | string[] | ((addr: string, hop: number) => boolean) {
  if (!v || v === "false") return false;
  const hops = v === "true" ? 1 : /^\d+$/.test(v) ? Number(v) : null;
  if (hops !== null) return (_addr: string, hop: number) => hop < hops;
  return v.split(",").map((x) => x.trim()).filter(Boolean);
}
