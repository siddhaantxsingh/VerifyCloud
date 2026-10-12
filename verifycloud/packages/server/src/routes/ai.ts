// AI debug assistant endpoints: preview of what would be sent, analysis,
// patch generation (LLM providers only), user patches, and patch
// verification in a fresh, isolated job. Patches are never merged or pushed.
import { randomUUID } from "node:crypto";

import { Type as T } from "@sinclair/typebox";
import type { ProjectConfig } from "@verifycloud/shared";
import type { FastifyInstance } from "fastify";

import { loadJob, loadOwned, loadTask, requirePrincipal } from "../access.js";
import type { Ctx } from "../app.js";
import { audit } from "../audit.js";
import { E } from "../errors.js";
import { fixedWindow } from "../ratelimit.js";
import type { JobSource } from "../scheduler.js";

const Id = T.Object({ id: T.String({ format: "uuid" }) });

export async function aiRoutes(api: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  api.get("/tasks/:id/analysis/preview", { schema: { tags: ["ai"], summary: "Exactly what an analysis would include and where it would go (nothing is sent)", params: Id } }, async (req) => {
    const { row } = await loadTask(db, requirePrincipal(req), (req.params as { id: string }).id, "engineer");
    const project = (await db.query("SELECT ai_settings FROM projects WHERE id = $1", [row.project_id])).rows[0];
    return { provider: ctx.ai.providerInfo(project.ai_settings ?? {}), ...(await ctx.ai.preview(row.id)) };
  });

  api.post("/tasks/:id/analyze", { schema: { tags: ["ai"], summary: "Analyze a failed run", params: Id } }, async (req, reply) => {
    const p = requirePrincipal(req);
    const { row } = await loadTask(db, p, (req.params as { id: string }).id, "engineer");
    const rl = await fixedWindow(db, `ai:${row.org_id}`, 30, 60);
    if (!rl.ok) throw E.rateLimited(rl.retryAfter);
    const analysis = await ctx.ai.analyze(row.id, p.kind === "user" ? p.userId : null);
    await audit(db, req, p, { orgId: row.org_id, action: "ai.analyze", targetType: "task", targetId: row.id, metadata: { provider: analysis.provider, external: analysis.external, status: analysis.status } });
    return reply.status(201).send({ analysis });
  });

  api.get("/analyses/:id", { schema: { tags: ["ai"], summary: "An analysis with its context manifest", params: Id } }, async (req) => {
    const { row } = await loadOwned(db, requirePrincipal(req), "analysis", "SELECT * FROM ai_analyses WHERE id = $1", (req.params as { id: string }).id);
    return { analysis: row };
  });

  api.post("/analyses/:id/patch", { schema: { tags: ["ai"], summary: "Generate a patch suggestion (LLM providers only; AI-generated, never applied automatically)", params: Id } }, async (req, reply) => {
    const p = requirePrincipal(req);
    const { row } = await loadOwned(db, p, "analysis", "SELECT * FROM ai_analyses WHERE id = $1", (req.params as { id: string }).id, "engineer");
    if (ctx.cfg.publicDemo) throw E.demo();
    const patch = await ctx.ai.generatePatch(row.id, p.kind === "user" ? p.userId : null);
    await audit(db, req, p, { orgId: row.org_id, action: "ai.patch_generate", targetType: "patch", targetId: patch.id });
    return reply.status(201).send({ patch: { ...patch, label: "AI-generated — review before use; verified only by running the tests" } });
  });

  api.post(
    "/jobs/:id/patches",
    { schema: { tags: ["ai"], summary: "Submit your own patch for verification against this job's sources", params: Id, body: T.Object({ diff: T.String({ minLength: 10, maxLength: 1_000_000 }) }, { additionalProperties: false }) } },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const { row } = await loadJob(db, p, (req.params as { id: string }).id, "engineer");
      if (ctx.cfg.publicDemo) throw E.demo();
      const diff = (req.body as { diff: string }).diff;
      const { files } = await ctx.ai.checkPatch(row.id, diff);
      const id = randomUUID();
      await db.query("INSERT INTO patches (id, org_id, project_id, job_id, origin, diff, files, created_by) VALUES ($1,$2,$3,$4,'user',$5,$6,$7)", [
        id, row.org_id, row.project_id, row.id, diff, files, p.kind === "user" ? p.userId : null,
      ]);
      await audit(db, req, p, { orgId: row.org_id, action: "patch.create", targetType: "patch", targetId: id });
      return reply.status(201).send({ patch: (await db.query("SELECT * FROM patches WHERE id = $1", [id])).rows[0] });
    },
  );

  api.get("/jobs/:id/patches", { schema: { tags: ["ai"], summary: "Patches proposed for this job and their verification jobs", params: Id } }, async (req) => {
    const { row } = await loadJob(db, requirePrincipal(req), (req.params as { id: string }).id);
    const r = await db.query(
      `SELECT p.id, p.origin, p.diff, p.files, p.analysis_id, p.created_at,
              (SELECT json_agg(json_build_object('id', j.id, 'number', j.number, 'state', j.state, 'summary', j.summary) ORDER BY j.created_at) FROM jobs j WHERE j.patch_id = p.id) AS verifications
         FROM patches p WHERE p.job_id = $1 ORDER BY p.created_at DESC`,
      [row.id],
    );
    return { patches: r.rows };
  });

  api.post("/patches/:id/verify", { schema: { tags: ["ai"], summary: "Run the regression with the patch applied, in a fresh isolated job", params: Id } }, async (req, reply) => {
    const p = requirePrincipal(req);
    const { row: patch } = await loadOwned(db, p, "patch", "SELECT * FROM patches WHERE id = $1", (req.params as { id: string }).id, "engineer");
    // in the public demo only pre-approved patches (created by the seed, no author) may run
    if (ctx.cfg.publicDemo && patch.created_by !== null) throw E.demo();
    const job = (await db.query("SELECT * FROM jobs WHERE id = $1", [patch.job_id])).rows[0];
    const rl = await fixedWindow(db, `jobs:${job.org_id}`, ctx.cfg.limits.jobCreatePerMinute, 60); // audit S8
    if (!rl.ok) throw E.rateLimited(rl.retryAfter);
    if (!job.config || !Object.keys(job.config).length) throw E.conflict("NOT_RERUNNABLE", "the original job has no recorded configuration");
    const src = job.source as JobSource;
    const source: JobSource = src.type === "snapshot" ? { type: "snapshot", snapshotId: src.snapshotId, artifactId: src.artifactId } : { type: "github", repository: src.repository, installationId: src.installationId, sha: src.sha };
    const { job: created } = await ctx.scheduler.createJob({
      orgId: job.org_id, projectId: job.project_id, regression: job.regression, trigger: "patch", source, config: job.config as ProjectConfig, configText: JSON.stringify(job.config),
      commitSha: job.commit_sha, branch: job.branch, requestedBy: p.kind === "user" ? p.userId : null, parentJobId: job.id, patchId: patch.id as string,
    });
    await audit(db, req, p, { orgId: job.org_id, action: "patch.verify", targetType: "job", targetId: created.id, metadata: { patch: patch.id, origin: patch.origin } });
    return reply.status(201).send({ job: created });
  });
}
