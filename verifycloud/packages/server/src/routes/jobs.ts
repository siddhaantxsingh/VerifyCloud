// Verification jobs: create, list, inspect, cancel, re-run, compare; test
// runs (tasks), logs, assertions, coverage, source navigation, reproduction.
import { gunzipSync } from "node:zlib";

import { Type as T } from "@sinclair/typebox";
import { buildIndex, coverageDelta, functionalPoints, moduleGraph, perFile, validateConfig, type CoverageDetail, type ProjectConfig } from "@verifycloud/shared";
import type { FastifyInstance } from "fastify";

import { loadJob, loadProject, loadTask, requirePrincipal, type Principal } from "../access.js";
import type { Ctx } from "../app.js";
import { audit } from "../audit.js";
import { E } from "../errors.js";
import { previousJob } from "../postjob.js";
import { fixedWindow } from "../ratelimit.js";
import type { JobSource } from "../scheduler.js";
import { readSnapshotFiles } from "../snapshot.js";
import { covSummary } from "./projects.js";

const Id = T.Object({ id: T.String({ format: "uuid" }) });
const CreateJob = T.Object(
  {
    regression: T.Optional(T.String({ pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,63}$" })),
    snapshotId: T.Optional(T.String({ format: "uuid" })),
    ref: T.Optional(T.String({ pattern: "^[A-Za-z0-9._/-]{1,200}$" })),
    tests: T.Optional(T.Array(T.String({ maxLength: 64 }), { maxItems: 500 })),
    idempotencyKey: T.Optional(T.String({ pattern: "^[A-Za-z0-9_.:-]{8,128}$" })),
  },
  { additionalProperties: false },
);

const sourceCache = new Map<string, { files: Map<string, string>; at: number }>();
export async function jobSources(ctx: Ctx, job: Record<string, any>): Promise<Map<string, string>> {
  const artId = job.source?.artifactId;
  if (!artId) throw E.conflict("SOURCES_UNAVAILABLE", "sources of this job are not available yet (build not finished) or have expired");
  const hit = sourceCache.get(artId);
  if (hit) return hit.files;
  const a = (await ctx.db.query("SELECT storage_key FROM artifacts WHERE id = $1 AND org_id = $2", [artId, job.org_id])).rows[0];
  if (!a) throw E.conflict("SOURCES_UNAVAILABLE", "sources of this job expired under the retention policy");
  const files = await readSnapshotFiles(await ctx.store.getBuffer(a.storage_key, 256 * 1024 * 1024), (p) => /\.(sv|svh|v|vh|ya?ml|f|mk|txt|md)$/i.test(p) || /(^|\/)Makefile$/.test(p), 2 * 1024 * 1024, 64 * 1024 * 1024);
  sourceCache.set(artId, { files, at: Date.now() });
  if (sourceCache.size > 50) sourceCache.delete(sourceCache.keys().next().value!);
  return files;
}

export async function compareJobs(ctx: Ctx, baseId: string, headId: string) {
  const q = (id: string) => ctx.db.query("SELECT test_name, seed, state, duration_ms FROM tasks WHERE job_id = $1 AND kind = 'test'", [id]);
  const [b, h] = await Promise.all([q(baseId), q(headId)]);
  const jobs = (await ctx.db.query("SELECT id, number, state, summary, coverage, branch, commit_sha, regression, created_at, started_at, finished_at FROM jobs WHERE id = ANY($1)", [[baseId, headId]])).rows;
  const base = jobs.find((j) => j.id === baseId)!;
  const head = jobs.find((j) => j.id === headId)!;
  const key = (r: { test_name: string; seed: string }) => `${r.test_name}#${r.seed}`;
  const bm = new Map(b.rows.map((r) => [key(r), r]));
  const hm = new Map(h.rows.map((r) => [key(r), r]));
  const newlyFailing: string[] = [];
  const fixed: string[] = [];
  const stillFailing: string[] = [];
  for (const [k, r] of hm) {
    const prev = bm.get(k);
    const pass = r.state === "PASSED";
    if (prev?.state === "PASSED" && !pass) newlyFailing.push(k);
    else if (prev && prev.state !== "PASSED" && pass) fixed.push(k);
    else if (prev && prev.state !== "PASSED" && !pass) stillFailing.push(k);
  }
  const counts = (rows: any[]) => ({ tests: rows.length, passed: rows.filter((r) => r.state === "PASSED").length, failed: rows.filter((r) => r.state !== "PASSED").length, testSeconds: rows.reduce((s, r) => s + (r.duration_ms ?? 0), 0) / 1000 });
  const asserts = (await ctx.db.query("SELECT job_id, count(*)::int AS n FROM assertion_failures WHERE job_id = ANY($1) GROUP BY job_id", [[baseId, headId]])).rows;
  const usage = (await ctx.db.query("SELECT job_id, kind, sum(quantity)::float AS q FROM usage_records WHERE job_id = ANY($1) GROUP BY job_id, kind", [[baseId, headId]])).rows;
  const wall = (j: any) => (j.started_at && j.finished_at ? (Date.parse(j.finished_at) - Date.parse(j.started_at)) / 1000 : null);
  const side = (j: any, rows: any[]) => ({
    job: { id: j.id, number: j.number, state: j.state, branch: j.branch, commit: j.commit_sha, regression: j.regression, createdAt: j.created_at },
    ...counts(rows),
    wallSeconds: wall(j),
    coverage: j.coverage,
    assertionFailures: asserts.find((a) => a.job_id === j.id)?.n ?? 0,
    usage: Object.fromEntries(usage.filter((u) => u.job_id === j.id).map((u) => [u.kind, u.q])),
  });
  return {
    base: side(base, b.rows),
    head: side(head, h.rows),
    newlyFailing,
    fixed,
    stillFailing,
    onlyInBase: [...bm.keys()].filter((k) => !hm.has(k)),
    onlyInHead: [...hm.keys()].filter((k) => !bm.has(k)),
    coverageDelta: coverageDelta(base.coverage, head.coverage),
  };
}

export async function createJobFor(ctx: Ctx, req: import("fastify").FastifyRequest, p: Principal, projectId: string, body: { regression?: string; snapshotId?: string; ref?: string; tests?: string[]; idempotencyKey?: string }, trigger: "api" | "cli" | "manual" = "api") {
  const { db, cfg } = ctx;
  const { row } = await loadProject(db, p, projectId, "engineer");
  const rl = await fixedWindow(db, `jobs:${row.org_id}`, cfg.limits.jobCreatePerMinute, 60);
  if (!rl.ok) throw E.rateLimited(rl.retryAfter);
  const idem = body.idempotencyKey ?? (typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : undefined);
  if (idem && !/^[A-Za-z0-9_.:-]{8,128}$/.test(idem)) throw E.validation("Idempotency-Key must be 8-128 characters of [A-Za-z0-9_.:-]");
  let source: JobSource;
  let configText: string | null;
  let commitSha: string | null = null;
  let branch: string | null = null;
  if (body.ref && !body.snapshotId) {
    if (cfg.publicDemo && row.is_demo) throw E.demo();
    const repo = row.repository_id ? (await db.query("SELECT * FROM repositories WHERE id = $1", [row.repository_id])).rows[0] : null;
    if (!repo?.installation_id || !ctx.github.configured) throw E.conflict("NO_REPOSITORY", "the project has no connected GitHub repository");
    const sha = /^[0-9a-f]{40}$/.test(body.ref) ? body.ref : await ctx.github.resolveRef(repo.installation_id, repo.full_name, body.ref);
    branch = /^[0-9a-f]{40}$/.test(body.ref) ? null : body.ref;
    commitSha = sha;
    configText = await ctx.github.getFile(repo.installation_id, repo.full_name, row.config_path as string, sha);
    source = { type: "github", repository: repo.full_name, installationId: Number(repo.installation_id), sha };
  } else {
    const snap = body.snapshotId
      ? (await db.query("SELECT * FROM source_snapshots WHERE id = $1 AND project_id = $2", [body.snapshotId, row.id])).rows[0]
      : (await db.query("SELECT * FROM source_snapshots WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1", [row.id])).rows[0];
    if (!snap) throw E.conflict("NO_SOURCE", "upload a source snapshot or pass ref for a connected repository");
    configText = snap.config_text;
    source = { type: "snapshot", snapshotId: snap.id, artifactId: snap.artifact_id };
    branch = "snapshot";
  }
  if (!configText) throw E.config([{ path: "(file)", message: `${row.config_path} not found` }]);
  const v = validateConfig(configText);
  if (!v.ok) throw E.config(v.issues);
  const regression = body.regression ?? (v.config.regressions.default ? "default" : Object.keys(v.config.regressions)[0]!);
  if (!v.config.regressions[regression]) throw E.validation(`unknown regression "${regression}"; defined: ${Object.keys(v.config.regressions).join(", ")}`);
  const { job, created } = await ctx.scheduler.createJob({
    orgId: row.org_id, projectId: row.id, regression, trigger: trigger, source, config: v.config, configText, commitSha, branch,
    requestedBy: p.kind === "user" ? p.userId : null, requestedToken: p.kind === "org_key" ? p.tokenId : (p.tokenId ?? null), idempotencyKey: idem ?? null, onlyTests: body.tests ?? null,
  });
  if (created) await audit(db, req, p, { orgId: row.org_id, action: "job.create", targetType: "job", targetId: job.id, metadata: { regression, trigger } });
  return { job, created };
}

export async function jobRoutes(api: FastifyInstance, ctx: Ctx) {
  const { db, scheduler } = ctx;

  api.post("/projects/:id/jobs", { schema: { tags: ["jobs"], summary: "Start a verification job (regression)", params: Id, body: CreateJob } }, async (req, reply) => {
    const p = requirePrincipal(req);
    const viaCli = String(req.headers["user-agent"] ?? "").startsWith("verifycloud-cli");
    const { job, created } = await createJobFor(ctx, req, p, (req.params as { id: string }).id, req.body as any, viaCli ? "cli" : p.kind === "user" && !p.tokenId ? "manual" : "api");
    return reply.status(created ? 201 : 200).send({ job, created });
  });

  api.post("/jobs", { schema: { tags: ["jobs"], summary: "Start a verification job (project in body)", body: T.Intersect([T.Object({ projectId: T.String({ format: "uuid" }) }), CreateJob]) } }, async (req, reply) => {
    const p = requirePrincipal(req);
    const { projectId, ...rest } = req.body as any;
    const { job, created } = await createJobFor(ctx, req, p, projectId, rest, "api");
    return reply.status(created ? 201 : 200).send({ job, created });
  });

  api.get(
    "/projects/:id/jobs",
    {
      schema: {
        tags: ["jobs"],
        summary: "List jobs (newest first, cursor pagination)",
        params: Id,
        querystring: T.Object({ before: T.Optional(T.Integer({ minimum: 1 })), limit: T.Optional(T.Integer({ minimum: 1, maximum: 100 })), state: T.Optional(T.String({ maxLength: 20 })), branch: T.Optional(T.String({ maxLength: 200 })), regression: T.Optional(T.String({ maxLength: 64 })) }),
      },
    },
    async (req) => {
      const { row } = await loadProject(db, requirePrincipal(req), (req.params as { id: string }).id);
      const q = req.query as { before?: number; limit?: number; state?: string; branch?: string; regression?: string };
      const params: unknown[] = [row.id];
      const conds = ["project_id = $1"];
      if (q.before) conds.push(`number < $${params.push(q.before)}`);
      if (q.state) conds.push(`state = $${params.push(q.state)}`);
      if (q.branch) conds.push(`branch = $${params.push(q.branch)}`);
      if (q.regression) conds.push(`regression = $${params.push(q.regression)}`);
      const limit = q.limit ?? 25;
      const r = await db.query(
        `SELECT id, number, state, trigger, regression, branch, commit_sha, pr_number, summary, coverage, error, parent_job_id, patch_id, created_at, started_at, finished_at
           FROM jobs WHERE ${conds.join(" AND ")} ORDER BY number DESC LIMIT ${limit}`,
        params,
      );
      return { jobs: r.rows, nextBefore: r.rows.length === limit ? r.rows[r.rows.length - 1].number : null };
    },
  );

  api.get("/jobs/:id", { schema: { tags: ["jobs"], summary: "Job details", params: Id } }, async (req) => {
    const { row, role } = await loadJob(db, requirePrincipal(req), (req.params as { id: string }).id);
    const build = (await db.query("SELECT id, state, attempt, duration_ms, exit_code, error, result, started_at, finished_at FROM tasks WHERE job_id = $1 AND kind = 'build'", [row.id])).rows[0];
    const project = (await db.query("SELECT id, name, slug FROM projects WHERE id = $1", [row.project_id])).rows[0];
    const patch = row.patch_id ? (await db.query("SELECT id, origin, diff, files, analysis_id, created_at FROM patches WHERE id = $1", [row.patch_id])).rows[0] : null;
    const { config, ...job } = row as Record<string, any>;
    return { job: { ...job, regressionTests: (config as ProjectConfig)?.regressions?.[row.regression as string]?.tests ?? [], simulator: (config as ProjectConfig)?.simulator ?? null, resources: (config as ProjectConfig)?.resources ?? null }, role, project, build, patch };
  });

  api.get("/jobs/:id/config", { schema: { tags: ["jobs"], summary: "The resolved configuration recorded for the job", params: Id } }, async (req) => {
    const { row } = await loadJob(db, requirePrincipal(req), (req.params as { id: string }).id);
    return { config: row.config, sha256: row.config_sha256, toolchain: row.toolchain };
  });

  api.post("/jobs/:id/cancel", { schema: { tags: ["jobs"], summary: "Cancel a job (running tests are stopped)", params: Id } }, async (req) => {
    const p = requirePrincipal(req);
    const { row } = await loadJob(db, p, (req.params as { id: string }).id, "engineer");
    const job = await scheduler.cancel(row.id);
    await audit(db, req, p, { orgId: row.org_id, action: "job.cancel", targetType: "job", targetId: row.id });
    return { job };
  });

  api.post(
    "/jobs/:id/rerun",
    { schema: { tags: ["jobs"], summary: "Re-run with the exact recorded source and configuration (new job)", params: Id, body: T.Optional(T.Object({ tests: T.Optional(T.Array(T.String({ maxLength: 64 }), { maxItems: 500 })) }, { additionalProperties: false })) } },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const { row } = await loadJob(db, p, (req.params as { id: string }).id, "engineer");
      // same per-organization limit as job creation (audit S8)
      const rl = await fixedWindow(db, `jobs:${row.org_id}`, ctx.cfg.limits.jobCreatePerMinute, 60);
      if (!rl.ok) throw E.rateLimited(rl.retryAfter);
      if (!row.config || !Object.keys(row.config as object).length) throw E.conflict("NOT_RERUNNABLE", "this job has no recorded configuration (it failed before starting)");
      const src = row.source as JobSource;
      const source: JobSource = src.type === "snapshot" ? { type: "snapshot", snapshotId: src.snapshotId, artifactId: src.artifactId } : { type: "github", repository: src.repository, installationId: src.installationId, sha: src.sha };
      const tests = (req.body as { tests?: string[] } | undefined)?.tests ?? (row.only_tests as string[] | null) ?? null;
      const { job } = await scheduler.createJob({
        orgId: row.org_id, projectId: row.project_id as string, regression: row.regression as string, trigger: "rerun", source, config: row.config as ProjectConfig,
        configText: JSON.stringify(row.config), commitSha: row.commit_sha as string | null, branch: row.branch as string | null, prNumber: row.pr_number as number | null,
        requestedBy: p.kind === "user" ? p.userId : null, parentJobId: row.id, onlyTests: tests, patchId: row.patch_id as string | null,
      });
      await audit(db, req, p, { orgId: row.org_id, action: "job.rerun", targetType: "job", targetId: job.id, metadata: { of: row.id } });
      return reply.status(201).send({ job });
    },
  );

  api.get(
    "/jobs/:id/tasks",
    { schema: { tags: ["jobs"], summary: "Test runs of a job", params: Id, querystring: T.Object({ state: T.Optional(T.String({ maxLength: 20 })), offset: T.Optional(T.Integer({ minimum: 0 })), limit: T.Optional(T.Integer({ minimum: 1, maximum: 500 })) }) } },
    async (req) => {
      const { row } = await loadJob(db, requirePrincipal(req), (req.params as { id: string }).id);
      const q = req.query as { state?: string; offset?: number; limit?: number };
      const params: unknown[] = [row.id];
      const conds = ["job_id = $1"];
      if (q.state === "failing") conds.push("state IN ('FAILED','ERROR','TIMED_OUT','RESOURCE_EXCEEDED')");
      else if (q.state) conds.push(`state = $${params.push(q.state)}`);
      const r = await db.query(
        `SELECT id, kind, ordinal, test_name, seed, state, attempt, duration_ms, exit_code, error, started_at, finished_at, result->>'summary' AS summary,
                (result->>'flaky')::boolean AS flaky, jsonb_array_length(test_attempts) AS failed_attempts
           FROM tasks WHERE ${conds.join(" AND ")} ORDER BY ordinal OFFSET ${q.offset ?? 0} LIMIT ${q.limit ?? 200}`,
        params,
      );
      return { tasks: r.rows };
    },
  );

  api.get("/tasks/:id", { schema: { tags: ["jobs"], summary: "One test run (or build) with results, artifacts, assertions, coverage", params: Id } }, async (req) => {
    const { row } = await loadTask(db, requirePrincipal(req), (req.params as { id: string }).id);
    const { lease_token: _lt, lease_worker: _lw, ...task } = row as Record<string, any>;
    const job = (await db.query("SELECT id, number, project_id, regression, state, commit_sha, branch, config->'simulator' AS simulator, toolchain FROM jobs WHERE id = $1", [row.job_id])).rows[0];
    const artifacts = (await db.query("SELECT id, kind, name, content_type, encoding, size_bytes, metadata, expires_at, created_at FROM artifacts WHERE task_id = $1 ORDER BY created_at", [row.id])).rows;
    const assertions = (await db.query("SELECT name, scope, severity, message, file, line, sim_time FROM assertion_failures WHERE task_id = $1 ORDER BY id", [row.id])).rows;
    const cov = (await db.query("SELECT * FROM coverage_runs WHERE task_id = $1", [row.id])).rows[0];
    const analyses = (await db.query("SELECT id, provider, model, external, status, result, error, latency_ms, created_at FROM ai_analyses WHERE task_id = $1 ORDER BY created_at DESC LIMIT 5", [row.id])).rows;
    return { task, job, artifacts, assertions, coverage: cov ? covSummary(cov) : null, analyses };
  });

  api.get(
    "/tasks/:id/log",
    {
      schema: {
        tags: ["jobs"],
        summary: "Search and page through a run's log (server-side filtering)",
        params: Id,
        querystring: T.Object({ q: T.Optional(T.String({ maxLength: 200 })), severity: T.Optional(T.Union([T.Literal("error"), T.Literal("warning")])), offset: T.Optional(T.Integer({ minimum: 0 })), limit: T.Optional(T.Integer({ minimum: 1, maximum: 2000 })) }),
      },
    },
    async (req) => {
      const { row } = await loadTask(db, requirePrincipal(req), (req.params as { id: string }).id);
      const a = (await db.query("SELECT id, storage_key, encoding, size_bytes, metadata FROM artifacts WHERE task_id = $1 AND kind = 'log' ORDER BY created_at DESC LIMIT 1", [row.id])).rows[0];
      if (!a) return { lines: [], total: 0, truncated: false, artifactId: null };
      let raw = await ctx.store.getBuffer(a.storage_key, 128 * 1024 * 1024);
      if (a.encoding === "gzip") raw = gunzipSync(raw, { maxOutputLength: 256 * 1024 * 1024 }); // bounded: artifacts come from untrusted runs
      const all = raw.toString("utf8").split("\n");
      const q = req.query as { q?: string; severity?: string; offset?: number; limit?: number };
      const sev = q.severity === "error" ? /%Error|%Fatal|error:|Assertion failed|VC_CHECK FAIL|VC_RESULT FAIL/i : q.severity === "warning" ? /%Warning|warning:/i : null;
      const needle = q.q?.toLowerCase();
      const matched: { n: number; text: string }[] = [];
      all.forEach((text, i) => {
        if (sev && !sev.test(text)) return;
        if (needle && !text.toLowerCase().includes(needle)) return;
        matched.push({ n: i + 1, text });
      });
      const off = q.offset ?? 0;
      const lim = q.limit ?? 500;
      return { lines: matched.slice(off, off + lim), total: matched.length, totalLines: all.length, truncated: Boolean((a.metadata as any)?.truncated), truncatedBytes: (a.metadata as any)?.droppedBytes ?? 0, artifactId: a.id };
    },
  );

  api.get("/jobs/:id/assertions", { schema: { tags: ["jobs"], summary: "Assertion failures of a job", params: Id } }, async (req) => {
    const { row } = await loadJob(db, requirePrincipal(req), (req.params as { id: string }).id);
    const r = await db.query(
      `SELECT a.name, a.scope, a.severity, a.message, a.file, a.line, a.sim_time, a.task_id, t.test_name, t.seed, j.commit_sha,
              (SELECT id FROM artifacts WHERE task_id = a.task_id AND kind = 'waveform' LIMIT 1) AS waveform_id
         FROM assertion_failures a JOIN tasks t ON t.id = a.task_id JOIN jobs j ON j.id = a.job_id WHERE a.job_id = $1 ORDER BY a.id LIMIT 500`,
      [row.id],
    );
    return { assertions: r.rows };
  });

  api.get("/jobs/:id/coverage", { schema: { tags: ["coverage"], summary: "Merged coverage of a job: summary, per file, functional points, delta vs previous", params: Id } }, async (req) => {
    const { row } = await loadJob(db, requirePrincipal(req), (req.params as { id: string }).id);
    const merged = (await db.query("SELECT cr.*, a.storage_key FROM coverage_runs cr LEFT JOIN artifacts a ON a.id = cr.detail_artifact_id WHERE cr.job_id = $1 AND cr.task_id IS NULL", [row.id])).rows[0];
    const perTest = (await db.query("SELECT cr.*, t.seed FROM coverage_runs cr JOIN tasks t ON t.id = cr.task_id WHERE cr.job_id = $1 ORDER BY t.ordinal", [row.id])).rows;
    let files = null;
    let functional = null;
    if (merged?.storage_key) {
      const d = JSON.parse(gunzipSync(await ctx.store.getBuffer(merged.storage_key, 64 * 1024 * 1024), { maxOutputLength: 512 * 1024 * 1024 }).toString("utf8")) as CoverageDetail;
      files = perFile(d).filter((f) => f.metrics.line || f.metrics.branch || f.metrics.toggle);
      functional = functionalPoints(d);
    }
    const prev = await previousJob(ctx, row);
    return {
      available: Boolean(merged),
      summary: merged ? covSummary(merged) : null,
      tool: (row.toolchain as any)?.simulatorVersion ?? null,
      files,
      functional,
      perTest: perTest.map((t) => ({ taskId: t.task_id, test: t.test_name, seed: Number(t.seed), coverage: covSummary(t) })),
      previous: prev ? { jobId: prev.id, number: prev.number, coverage: prev.coverage } : null,
      delta: coverageDelta(prev?.coverage, row.coverage as any),
    };
  });

  api.get(
    "/jobs/:id/compare",
    { schema: { tags: ["jobs"], summary: "Compare with another job (default: previous run of the same regression and branch)", params: Id, querystring: T.Object({ with: T.Optional(T.String({ format: "uuid" })) }) } },
    async (req) => {
      const p = requirePrincipal(req);
      const { row } = await loadJob(db, p, (req.params as { id: string }).id);
      const w = (req.query as { with?: string }).with;
      let baseId: string;
      if (w) {
        const { row: other } = await loadJob(db, p, w);
        if (other.org_id !== row.org_id) throw E.notFound("job");
        baseId = other.id;
      } else {
        const prev = await previousJob(ctx, row);
        if (!prev) throw E.notFound("previous job");
        baseId = prev.id;
      }
      return compareJobs(ctx, baseId, row.id);
    },
  );

  api.get(
    "/projects/:id/compare",
    { schema: { tags: ["jobs"], summary: "Compare the latest runs of two branches (or two jobs)", params: Id, querystring: T.Object({ base: T.String({ maxLength: 200 }), head: T.String({ maxLength: 200 }), regression: T.Optional(T.String({ maxLength: 64 })) }) } },
    async (req) => {
      const p = requirePrincipal(req);
      const { row } = await loadProject(db, p, (req.params as { id: string }).id);
      const q = req.query as { base: string; head: string; regression?: string };
      const pick = async (x: string) => {
        const isId = /^[0-9a-f-]{36}$/.test(x);
        const r = await db.query(
          `SELECT id FROM jobs WHERE project_id = $1 AND ${isId ? "id = $2" : /^[0-9a-f]{40}$/.test(x) ? "commit_sha = $2" : "branch = $2"} ${q.regression ? "AND regression = $3" : ""} AND finished_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
          q.regression ? [row.id, x, q.regression] : [row.id, x],
        );
        if (!r.rows[0]) throw E.notFound(`job for ${x}`);
        return r.rows[0].id as string;
      };
      return compareJobs(ctx, await pick(q.base), await pick(q.head));
    },
  );

  // -------------------------------------------------- source navigation
  api.get("/jobs/:id/source/index", { schema: { tags: ["source"], summary: "SystemVerilog symbols of the job's sources (partial parser)", params: Id, querystring: T.Object({ q: T.Optional(T.String({ maxLength: 100 })), module: T.Optional(T.String({ maxLength: 100 })) }) } }, async (req) => {
    const { row } = await loadJob(db, requirePrincipal(req), (req.params as { id: string }).id);
    const files = await jobSources(ctx, row);
    const idx = buildIndex([...files].map(([path, content]) => ({ path, content })));
    const q = (req.query as { q?: string }).q?.toLowerCase();
    const mod = (req.query as { module?: string }).module;
    return {
      parser: "partial (pattern-based); see docs/ai-debugging.md",
      files: idx.files,
      symbols: idx.symbols.filter((s) => s.kind !== "port" && (!q || s.name.toLowerCase().includes(q))).slice(0, 2000),
      graph: mod ? moduleGraph(idx, mod) : undefined,
    };
  });

  api.get(
    "/jobs/:id/source/file",
    { schema: { tags: ["source"], summary: "A source file (or line range) of the job", params: Id, querystring: T.Object({ path: T.String({ maxLength: 400 }), from: T.Optional(T.Integer({ minimum: 1 })), to: T.Optional(T.Integer({ minimum: 1 })) }) } },
    async (req) => {
      const { row } = await loadJob(db, requirePrincipal(req), (req.params as { id: string }).id);
      const q = req.query as { path: string; from?: number; to?: number };
      const files = await jobSources(ctx, row);
      const content = files.get(q.path);
      if (content === undefined) throw E.notFound("file");
      const lines = content.split("\n");
      const from = q.from ?? 1;
      const to = Math.min(lines.length, q.to ?? lines.length, from + 5000);
      return { path: q.path, from, to, totalLines: lines.length, lines: lines.slice(from - 1, to) };
    },
  );

  api.get("/tasks/:id/reproduce", { schema: { tags: ["jobs"], summary: "Everything needed to reproduce a test run locally", params: Id } }, async (req) => {
    const { row } = await loadTask(db, requirePrincipal(req), (req.params as { id: string }).id);
    const job = (await db.query("SELECT * FROM jobs WHERE id = $1", [row.job_id])).rows[0];
    const build = (await db.query("SELECT result FROM tasks WHERE job_id = $1 AND kind = 'build'", [row.job_id])).rows[0];
    const plusargs = Object.entries((row.plusargs as Record<string, string>) ?? {}).map(([k, v]) => `+${k}=${v}`);
    return {
      commit: job.commit_sha,
      branch: job.branch,
      source: job.source,
      configSha256: job.config_sha256,
      toolchain: job.toolchain,
      test: row.test_name,
      seed: row.seed === null ? null : Number(row.seed),
      buildCommand: build?.result?.command ?? null,
      runCommand: row.kind === "test" ? `./sim ${plusargs.join(" ")}` : null,
      rerunApi: `POST /api/v1/jobs/${job.id}/rerun {"tests": ["${row.test_name}"]}`,
    };
  });
}
