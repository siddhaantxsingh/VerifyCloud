// Projects: CRUD, configuration validation, detection, secrets, source
// snapshots, repository connection, notifications, history, dashboard.
import { randomUUID } from "node:crypto";

import { Type as T } from "@sinclair/typebox";
import { coverageDelta, detectProject, validateConfig } from "@verifycloud/shared";
import type { FastifyInstance } from "fastify";

import { loadProject, requirePrincipal, requireUser, resolveOrg } from "../access.js";
import type { Ctx } from "../app.js";
import { storeArtifact } from "../artifacts.js";
import { audit } from "../audit.js";
import { encryptSecret } from "../crypto.js";
import { tx } from "../db.js";
import { E } from "../errors.js";
import { validateTargetUrl } from "../netguard.js";
import { NOTIFICATION_EVENTS } from "../notify.js";
import { upsertCatalog } from "../scheduler.js";
import { inspectSnapshot } from "../snapshot.js";

const Id = T.Object({ id: T.String({ format: "uuid" }) });
const Retention = T.Object(
  { logs: T.Integer({ minimum: 1, maximum: 3650 }), waveforms: T.Integer({ minimum: 1, maximum: 3650 }), coverage: T.Integer({ minimum: 1, maximum: 3650 }), models: T.Integer({ minimum: 1, maximum: 3650 }), sources: T.Integer({ minimum: 1, maximum: 3650 }) },
  { additionalProperties: false },
);

export const covSummary = (r: Record<string, any>) => {
  const s: Record<string, { covered: number; total: number }> = {};
  for (const k of ["line", "branch", "toggle", "functional"]) if (r[`${k}_total`] !== null && r[`${k}_total`] !== undefined) s[k] = { covered: r[`${k}_covered`], total: r[`${k}_total`] };
  return s;
};

export async function projectRoutes(api: FastifyInstance, ctx: Ctx) {
  const { db, cfg } = ctx;

  api.get("/orgs/:org/projects", { schema: { tags: ["projects"], summary: "List projects", params: T.Object({ org: T.String() }) } }, async (req) => {
    const { org } = await resolveOrg(db, requirePrincipal(req), (req.params as { org: string }).org);
    const r = await db.query(
      `SELECT p.id, p.slug, p.name, p.description, p.state, p.created_at, r.full_name AS repository,
              lj.id AS last_job_id, lj.number AS last_job_number, lj.state AS last_job_state, lj.created_at AS last_job_at, lj.summary AS last_job_summary, lj.coverage AS last_job_coverage
         FROM projects p
         LEFT JOIN repositories r ON r.id = p.repository_id
         LEFT JOIN LATERAL (SELECT id, number, state, created_at, summary, coverage FROM jobs WHERE project_id = p.id ORDER BY created_at DESC LIMIT 1) lj ON true
        WHERE p.org_id = $1 ORDER BY p.name`,
      [org.id],
    );
    return { projects: r.rows };
  });

  api.post(
    "/orgs/:org/projects",
    {
      schema: {
        tags: ["projects"],
        summary: "Create a project",
        params: T.Object({ org: T.String() }),
        body: T.Object({ name: T.String({ minLength: 1, maxLength: 100 }), slug: T.String({ pattern: "^[a-z0-9][a-z0-9-]{0,62}$" }), description: T.Optional(T.String({ maxLength: 2000 })) }, { additionalProperties: false }),
      },
    },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const { org } = await resolveOrg(db, p, (req.params as { org: string }).org, "admin");
      if (org.is_demo && cfg.publicDemo) throw E.demo();
      const b = req.body as { name: string; slug: string; description?: string };
      const id = randomUUID();
      try {
        await tx(db, async (c) => {
          await c.query("INSERT INTO projects (id, org_id, slug, name, description) VALUES ($1,$2,$3,$4,$5)", [id, org.id, b.slug, b.name, b.description ?? ""]);
          await audit(c, req, p, { orgId: org.id, action: "project.create", targetType: "project", targetId: id });
        });
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw E.conflict("SLUG_TAKEN", "a project with this slug exists in the organization");
        throw e;
      }
      return reply.status(201).send({ project: (await db.query("SELECT * FROM projects WHERE id = $1", [id])).rows[0] });
    },
  );

  api.get("/projects/:id", { schema: { tags: ["projects"], summary: "Project details", params: Id } }, async (req) => {
    const { row, role } = await loadProject(db, requirePrincipal(req), (req.params as { id: string }).id);
    const repo = row.repository_id ? (await db.query("SELECT full_name, default_branch, installation_id FROM repositories WHERE id = $1", [row.repository_id])).rows[0] : null;
    const latest = (await db.query("SELECT id, number, state, regression, branch, commit_sha, summary, coverage, created_at, finished_at FROM jobs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1", [row.id])).rows[0] ?? null;
    const failing = latest
      ? (await db.query("SELECT id, test_name, seed, state FROM tasks WHERE job_id = $1 AND kind = 'test' AND state IN ('FAILED','ERROR','TIMED_OUT','RESOURCE_EXCEEDED') ORDER BY ordinal LIMIT 20", [latest.id])).rows
      : [];
    const snapshot = (await db.query("SELECT id, sha256, file_count, created_at, config_text IS NOT NULL AS has_config FROM source_snapshots WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1", [row.id])).rows[0] ?? null;
    return { project: { ...row, role }, repository: repo, latestJob: latest, failing, latestSnapshot: snapshot, ai: ctx.ai.providerInfo((row.ai_settings as object) ?? {}) };
  });

  api.patch(
    "/projects/:id",
    {
      schema: {
        tags: ["projects"],
        summary: "Update project settings (admin)",
        params: Id,
        body: T.Object(
          {
            name: T.Optional(T.String({ minLength: 1, maxLength: 100 })),
            description: T.Optional(T.String({ maxLength: 2000 })),
            state: T.Optional(T.Union([T.Literal("active"), T.Literal("paused"), T.Literal("archived")])),
            branch: T.Optional(T.Union([T.String({ pattern: "^[A-Za-z0-9._/-]{1,200}$" }), T.Null()])),
            configPath: T.Optional(T.String({ pattern: "^[A-Za-z0-9._/-]{1,200}$" })),
            maxConcurrency: T.Optional(T.Integer({ minimum: 1, maximum: 256 })),
            retention: T.Optional(Retention),
            aiSettings: T.Optional(T.Object({ provider: T.Union([T.Literal("heuristic"), T.Literal("openai"), T.Literal("local")]), allowExternal: T.Boolean() }, { additionalProperties: false })),
            prChecks: T.Optional(T.Boolean()),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { row } = await loadProject(db, p, (req.params as { id: string }).id, "admin");
      if (row.is_demo && cfg.publicDemo) throw E.demo();
      const b = req.body as Record<string, unknown>;
      if (b.configPath && String(b.configPath).split("/").includes("..")) throw E.validation("configPath must not contain ..");
      if (b.retention) {
        const max = (await db.query("SELECT pl.max_retention_days FROM organizations o JOIN plans pl ON pl.name = o.plan WHERE o.id = $1", [row.org_id])).rows[0].max_retention_days;
        for (const [k, v] of Object.entries(b.retention as Record<string, number>))
          if (v > max[k]) throw E.validation(`retention.${k} exceeds the plan limit of ${max[k]} days`);
      }
      const map: Record<string, string> = { name: "name", description: "description", state: "state", branch: "branch", configPath: "config_path", maxConcurrency: "max_concurrency", retention: "retention", aiSettings: "ai_settings", prChecks: "pr_checks" };
      const sets: string[] = [];
      const vals: unknown[] = [row.id];
      for (const [k, col] of Object.entries(map))
        if (k in b) sets.push(`${col} = $${vals.push(typeof b[k] === "object" && b[k] !== null ? JSON.stringify(b[k]) : b[k])}`);
      if (!sets.length) throw E.validation("nothing to update");
      await tx(db, async (c) => {
        await c.query(`UPDATE projects SET ${sets.join(", ")} WHERE id = $1`, vals);
        await audit(c, req, p, { orgId: row.org_id, action: "project.update", targetType: "project", targetId: row.id, metadata: { fields: Object.keys(b) } });
      });
      return { project: (await db.query("SELECT * FROM projects WHERE id = $1", [row.id])).rows[0] };
    },
  );

  api.delete("/projects/:id", { schema: { tags: ["projects"], summary: "Delete a project and all its data (owner/admin)", params: Id } }, async (req) => {
    const p = requirePrincipal(req);
    const { row } = await loadProject(db, p, (req.params as { id: string }).id, "admin");
    if (row.is_demo && cfg.publicDemo) throw E.demo();
    await tx(db, async (c) => {
      // artifact rows cascade; the trigger queues every object key for deletion
      await c.query("DELETE FROM projects WHERE id = $1", [row.id]);
      await audit(c, req, p, { orgId: row.org_id, action: "project.delete", targetType: "project", targetId: row.id, metadata: { slug: row.slug } });
    });
    return { ok: true };
  });

  // -------------------------------------------------- configuration
  api.post(
    "/projects/:id/config/validate",
    { schema: { tags: ["projects"], summary: "Validate a verifycloud.yaml", params: Id, body: T.Object({ text: T.String({ maxLength: 262144 }) }, { additionalProperties: false }) } },
    async (req) => {
      await loadProject(db, requirePrincipal(req), (req.params as { id: string }).id);
      const r = validateConfig((req.body as { text: string }).text);
      return r.ok ? { ok: true, regressions: Object.keys(r.config.regressions), tests: Object.keys(r.config.tests), config: r.config } : { ok: false, issues: r.issues };
    },
  );

  api.post(
    "/projects/:id/detect",
    {
      schema: {
        tags: ["projects"],
        summary: "Detect HDL project structure and propose a configuration",
        params: Id,
        body: T.Object({ files: T.Array(T.Object({ path: T.String({ maxLength: 400 }), content: T.Optional(T.String({ maxLength: 65536 })) }), { maxItems: 5000 }) }, { additionalProperties: false }),
      },
    },
    async (req) => {
      await loadProject(db, requirePrincipal(req), (req.params as { id: string }).id);
      return detectProject((req.body as { files: { path: string; content?: string }[] }).files);
    },
  );

  // -------------------------------------------------- source snapshots
  api.post(
    "/projects/:id/snapshots",
    { schema: { tags: ["projects"], summary: "Upload a source snapshot (tar.gz body, Content-Type: application/gzip)", params: Id }, bodyLimit: cfg.limits.maxUploadBytes },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const { row } = await loadProject(db, p, (req.params as { id: string }).id, "engineer");
      if (row.is_demo && cfg.publicDemo) throw E.demo();
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) throw E.validation("send the snapshot as a gzip-compressed tar archive with Content-Type: application/gzip");
      const info = await inspectSnapshot(body, row.config_path as string);
      const validation = info.configText === null ? { ok: false as const, issues: [{ path: "(file)", message: `${row.config_path} not found in the snapshot` }] } : validateConfig(info.configText);
      const art = await storeArtifact(ctx, { orgId: row.org_id, projectId: row.id, jobId: null, taskId: null, kind: "source", name: "source.tar.gz", contentType: "application/gzip", body, metadata: { files: info.fileCount } });
      const id = randomUUID();
      const sha = (await db.query("SELECT sha256 FROM artifacts WHERE id = $1", [art.id])).rows[0].sha256;
      await db.query("INSERT INTO source_snapshots (id, org_id, project_id, artifact_id, sha256, file_count, config_text, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
        id, row.org_id, row.id, art.id, sha, info.fileCount, info.configText, p.kind === "user" ? p.userId : null,
      ]);
      if (validation.ok) await upsertCatalog(db, row.id, validation.config);
      await audit(db, req, p, { orgId: row.org_id, action: "snapshot.upload", targetType: "snapshot", targetId: id, metadata: { bytes: body.length, files: info.fileCount } });
      return reply.status(201).send({
        snapshot: { id, sha256: sha, fileCount: info.fileCount, bytes: body.length },
        config: validation.ok ? { ok: true, regressions: Object.keys(validation.config.regressions), tests: Object.keys(validation.config.tests) } : validation,
      });
    },
  );

  api.get("/projects/:id/snapshots", { schema: { tags: ["projects"], summary: "List source snapshots", params: Id } }, async (req) => {
    const { row } = await loadProject(db, requirePrincipal(req), (req.params as { id: string }).id);
    const r = await db.query("SELECT id, sha256, file_count, config_text IS NOT NULL AS has_config, created_at FROM source_snapshots WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50", [row.id]);
    return { snapshots: r.rows };
  });

  // -------------------------------------------------- repository (GitHub)
  api.post(
    "/projects/:id/repository",
    {
      schema: {
        tags: ["projects", "github"],
        summary: "Connect a GitHub repository through a GitHub App installation of this organization",
        params: Id,
        body: T.Object({ fullName: T.String({ pattern: "^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$" }), installationId: T.Integer({ minimum: 1 }), defaultBranch: T.Optional(T.String({ pattern: "^[A-Za-z0-9._/-]{1,200}$" })) }, { additionalProperties: false }),
      },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { row } = await loadProject(db, p, (req.params as { id: string }).id, "admin");
      const b = req.body as { fullName: string; installationId: number; defaultBranch?: string };
      const inst = (await db.query("SELECT * FROM github_installations WHERE installation_id = $1 AND org_id = $2 AND removed_at IS NULL", [b.installationId, row.org_id])).rows[0];
      if (!inst) throw E.notFound("GitHub installation");
      if (b.fullName.split("/")[0]!.toLowerCase() !== String(inst.account_login).toLowerCase()) throw E.validation("the repository does not belong to the installation's account");
      await tx(db, async (c) => {
        const repo = (
          await c.query(
            `INSERT INTO repositories (id, org_id, provider, full_name, installation_id, default_branch) VALUES ($1,$2,'github',$3,$4,$5)
             ON CONFLICT (org_id, provider, full_name) DO UPDATE SET installation_id = EXCLUDED.installation_id, default_branch = EXCLUDED.default_branch RETURNING id`,
            [randomUUID(), row.org_id, b.fullName, b.installationId, b.defaultBranch ?? "main"],
          )
        ).rows[0];
        await c.query("UPDATE projects SET repository_id = $2 WHERE id = $1", [row.id, repo.id]);
        await audit(c, req, p, { orgId: row.org_id, action: "project.repository_connect", targetType: "project", targetId: row.id, metadata: { repository: b.fullName } });
      });
      return { ok: true };
    },
  );

  api.delete("/projects/:id/repository", { schema: { tags: ["projects", "github"], summary: "Disconnect the repository", params: Id } }, async (req) => {
    const p = requirePrincipal(req);
    const { row } = await loadProject(db, p, (req.params as { id: string }).id, "admin");
    await db.query("UPDATE projects SET repository_id = NULL WHERE id = $1", [row.id]);
    await audit(db, req, p, { orgId: row.org_id, action: "project.repository_disconnect", targetType: "project", targetId: row.id });
    return { ok: true };
  });

  api.get("/orgs/:org/github/installations", { schema: { tags: ["github"], summary: "GitHub App installations of the organization", params: T.Object({ org: T.String() }) } }, async (req) => {
    const { org } = await resolveOrg(db, requirePrincipal(req), (req.params as { org: string }).org, "admin");
    const r = await db.query("SELECT installation_id, account_login, created_at FROM github_installations WHERE org_id = $1 AND removed_at IS NULL", [org.id]);
    return { installations: r.rows, configured: ctx.github.configured };
  });

  api.post(
    "/orgs/:org/github/installations/claim",
    { schema: { tags: ["github"], summary: "Bind a GitHub App installation you created to this organization", params: T.Object({ org: T.String() }), body: T.Object({ installationId: T.Integer({ minimum: 1 }) }, { additionalProperties: false }) } },
    async (req) => {
      const u = requireUser(req);
      const { org } = await resolveOrg(db, u, (req.params as { org: string }).org, "admin");
      const ghId = (await db.query("SELECT github_user_id FROM users WHERE id = $1", [u.userId])).rows[0]?.github_user_id;
      if (!ghId) throw E.validation("link your GitHub account first (log in with GitHub once)");
      const { installationId } = req.body as { installationId: number };
      // Only the GitHub user who installed the app (from the signed installation
      // webhook) may claim it — matched by the immutable numeric GitHub user id,
      // not the login, which can be renamed and re-registered (audit S9).
      const r = await db.query(
        "UPDATE github_installations SET org_id = $2 WHERE installation_id = $1 AND org_id IS NULL AND removed_at IS NULL AND sender_id IS NOT NULL AND sender_id = $3 RETURNING installation_id, account_login",
        [installationId, org.id, ghId],
      );
      if (!r.rows[0]) throw E.notFound("unclaimed GitHub installation created by your GitHub account");
      await audit(db, req, u, { orgId: org.id, action: "github.installation_claim", targetType: "github_installation", targetId: String(installationId) });
      return { installation: r.rows[0] };
    },
  );

  // -------------------------------------------------- secrets (write-only values)
  api.get("/projects/:id/secrets", { schema: { tags: ["projects"], summary: "List secret names (values are never returned)", params: Id } }, async (req) => {
    const { row } = await loadProject(db, requirePrincipal(req), (req.params as { id: string }).id, "admin");
    return { secrets: (await db.query("SELECT name, updated_at FROM project_secrets WHERE project_id = $1 ORDER BY name", [row.id])).rows };
  });

  api.put(
    "/projects/:id/secrets/:name",
    { schema: { tags: ["projects"], summary: "Create or replace a secret", params: T.Object({ id: T.String({ format: "uuid" }), name: T.String({ pattern: "^[A-Z_][A-Z0-9_]{0,63}$" }) }), body: T.Object({ value: T.String({ minLength: 1, maxLength: 8192 }) }, { additionalProperties: false }) } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id, name } = req.params as { id: string; name: string };
      const { row } = await loadProject(db, p, id, "admin");
      if (row.is_demo && cfg.publicDemo) throw E.demo();
      const { ciphertext, nonce } = encryptSecret(cfg.secretKey, (req.body as { value: string }).value);
      await db.query(
        `INSERT INTO project_secrets (id, org_id, project_id, name, ciphertext, nonce, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (project_id, name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, updated_at = now()`,
        [randomUUID(), row.org_id, row.id, name, ciphertext, nonce, p.kind === "user" ? p.userId : null],
      );
      await audit(db, req, p, { orgId: row.org_id, action: "secret.set", targetType: "project", targetId: row.id, metadata: { name } });
      return { ok: true };
    },
  );

  api.delete("/projects/:id/secrets/:name", { schema: { tags: ["projects"], summary: "Delete a secret", params: T.Object({ id: T.String({ format: "uuid" }), name: T.String() }) } }, async (req) => {
    const p = requirePrincipal(req);
    const { id, name } = req.params as { id: string; name: string };
    const { row } = await loadProject(db, p, id, "admin");
    const r = await db.query("DELETE FROM project_secrets WHERE project_id = $1 AND name = $2", [row.id, name]);
    if (!r.rowCount) throw E.notFound("secret");
    await audit(db, req, p, { orgId: row.org_id, action: "secret.delete", targetType: "project", targetId: row.id, metadata: { name } });
    return { ok: true };
  });

  // -------------------------------------------------- notifications
  api.get("/projects/:id/notifications", { schema: { tags: ["projects"], summary: "Notification channels", params: Id } }, async (req) => {
    const { row } = await loadProject(db, requirePrincipal(req), (req.params as { id: string }).id, "admin");
    const r = await db.query("SELECT id, kind, target, events, enabled, secret_ciphertext IS NOT NULL AS signed, created_at FROM notification_channels WHERE project_id = $1 ORDER BY created_at", [row.id]);
    const recent = await db.query(
      "SELECT n.id, n.kind, n.event, n.status, n.attempts, n.last_error, n.created_at, n.sent_at FROM notifications n JOIN notification_channels c ON c.id = n.channel_id WHERE c.project_id = $1 ORDER BY n.id DESC LIMIT 20",
      [row.id],
    );
    return { channels: r.rows, recentDeliveries: recent.rows };
  });

  api.post(
    "/projects/:id/notifications",
    {
      schema: {
        tags: ["projects"],
        summary: "Add a notification channel",
        params: Id,
        body: T.Object(
          { kind: T.Union([T.Literal("email"), T.Literal("webhook")]), target: T.String({ minLength: 3, maxLength: 500 }), events: T.Array(T.Union(NOTIFICATION_EVENTS.map((e) => T.Literal(e))), { minItems: 1 }), secret: T.Optional(T.String({ minLength: 16, maxLength: 200 })) },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const { row } = await loadProject(db, p, (req.params as { id: string }).id, "admin");
      if (row.is_demo && cfg.publicDemo) throw E.demo();
      const b = req.body as { kind: "email" | "webhook"; target: string; events: string[]; secret?: string };
      if (b.kind === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.target)) throw E.validation("target must be an email address");
      if (b.kind === "webhook") {
        try {
          validateTargetUrl(b.target, process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS === "true");
        } catch (e) {
          throw E.validation(`webhook URL rejected: ${(e as Error).message}`);
        }
      }
      const enc = b.secret ? encryptSecret(cfg.secretKey, b.secret) : null;
      const id = randomUUID();
      await db.query("INSERT INTO notification_channels (id, org_id, project_id, kind, target, events, secret_ciphertext, secret_nonce) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
        id, row.org_id, row.id, b.kind, b.target, b.events, enc?.ciphertext ?? null, enc?.nonce ?? null,
      ]);
      await audit(db, req, p, { orgId: row.org_id, action: "notification.create", targetType: "project", targetId: row.id, metadata: { kind: b.kind, events: b.events } });
      return reply.status(201).send({ id });
    },
  );

  api.delete("/projects/:id/notifications/:channel", { schema: { tags: ["projects"], summary: "Remove a notification channel", params: T.Object({ id: T.String({ format: "uuid" }), channel: T.String({ format: "uuid" }) }) } }, async (req) => {
    const p = requirePrincipal(req);
    const { id, channel } = req.params as { id: string; channel: string };
    const { row } = await loadProject(db, p, id, "admin");
    const r = await db.query("DELETE FROM notification_channels WHERE id = $1 AND project_id = $2", [channel, row.id]);
    if (!r.rowCount) throw E.notFound("notification channel");
    return { ok: true };
  });

  // -------------------------------------------------- history & dashboards
  api.get("/projects/:id/regressions", { schema: { tags: ["regressions"], summary: "Regressions with their latest result", params: Id } }, async (req) => {
    const { row } = await loadProject(db, requirePrincipal(req), (req.params as { id: string }).id);
    const r = await db.query(
      `SELECT g.name, g.tests, g.updated_at, lj.id AS last_job_id, lj.number, lj.state, lj.summary, lj.coverage, lj.created_at AS last_run_at,
              (SELECT count(*)::int FROM jobs WHERE project_id = g.project_id AND regression = g.name) AS runs
         FROM regressions g
         LEFT JOIN LATERAL (SELECT id, number, state, summary, coverage, created_at FROM jobs WHERE project_id = g.project_id AND regression = g.name ORDER BY created_at DESC LIMIT 1) lj ON true
        WHERE g.project_id = $1 ORDER BY g.name`,
      [row.id],
    );
    return { regressions: r.rows };
  });

  api.get(
    "/projects/:id/tests/:name/history",
    { schema: { tags: ["regressions"], summary: "Recent results of one test", params: T.Object({ id: T.String({ format: "uuid" }), name: T.String({ maxLength: 64 }) }), querystring: T.Object({ limit: T.Optional(T.Integer({ minimum: 1, maximum: 200 })) }) } },
    async (req) => {
      const { id, name } = req.params as { id: string; name: string };
      const { row } = await loadProject(db, requirePrincipal(req), id);
      const r = await db.query(
        `SELECT t.id, t.seed, t.state, t.duration_ms, t.finished_at, (t.result->>'flaky')::boolean AS flaky, j.id AS job_id, j.number, j.commit_sha, j.branch
           FROM tasks t JOIN jobs j ON j.id = t.job_id WHERE t.project_id = $1 AND t.kind = 'test' AND t.test_name = $2 AND t.finished_at IS NOT NULL
          ORDER BY t.finished_at DESC LIMIT $3`,
        [row.id, name, (req.query as { limit?: number }).limit ?? 50],
      );
      return { history: r.rows };
    },
  );

  api.get(
    "/projects/:id/coverage",
    {
      schema: {
        tags: ["coverage"],
        summary: "Coverage history (merged per job) for a branch/regression",
        params: Id,
        querystring: T.Object({ branch: T.Optional(T.String({ maxLength: 200 })), regression: T.Optional(T.String({ maxLength: 64 })), limit: T.Optional(T.Integer({ minimum: 1, maximum: 500 })) }),
      },
    },
    async (req) => {
      const { row } = await loadProject(db, requirePrincipal(req), (req.params as { id: string }).id);
      const q = req.query as { branch?: string; regression?: string; limit?: number };
      const params: unknown[] = [row.id];
      const conds = ["cr.project_id = $1", "cr.task_id IS NULL"];
      if (q.branch) conds.push(`cr.branch = $${params.push(q.branch)}`);
      if (q.regression) conds.push(`cr.regression = $${params.push(q.regression)}`);
      const r = await db.query(
        `SELECT cr.*, j.number, j.state FROM coverage_runs cr JOIN jobs j ON j.id = cr.job_id WHERE ${conds.join(" AND ")} ORDER BY cr.created_at DESC LIMIT ${q.limit ?? 100}`,
        params,
      );
      const points = r.rows.map((x) => ({ jobId: x.job_id, number: x.number, state: x.state, branch: x.branch, commit: x.commit_sha, regression: x.regression, at: x.created_at, coverage: covSummary(x) }));
      const latest = points[0];
      const previous = points[1];
      return { history: points.reverse(), delta: latest && previous ? coverageDelta(previous.coverage, latest.coverage) : {} };
    },
  );

  api.get("/orgs/:org/dashboard", { schema: { tags: ["organizations"], summary: "Dashboard data: recent runs, rates, coverage, workers, queue", params: T.Object({ org: T.String() }) } }, async (req) => {
    const { org } = await resolveOrg(db, requirePrincipal(req), (req.params as { org: string }).org);
    const recent = await db.query(
      `SELECT j.id, j.number, j.state, j.regression, j.branch, j.commit_sha, j.trigger, j.summary, j.coverage, j.created_at, j.finished_at, p.id AS project_id, p.name AS project_name
         FROM jobs j JOIN projects p ON p.id = j.project_id WHERE j.org_id = $1 ORDER BY j.created_at DESC LIMIT 15`,
      [org.id],
    );
    const rates = await db.query(
      `SELECT count(*) FILTER (WHERE state = 'PASSED')::int AS passed, count(*) FILTER (WHERE state IN ('FAILED','ERROR','TIMED_OUT','RESOURCE_EXCEEDED'))::int AS failed, count(*)::int AS total
         FROM tasks WHERE org_id = $1 AND kind = 'test' AND finished_at > now() - interval '7 days'`,
      [org.id],
    );
    const usage = await db.query("SELECT kind, sum(quantity)::float AS q FROM usage_records WHERE org_id = $1 AND created_at > now() - interval '7 days' GROUP BY kind", [org.id]);
    const queue = await db.query(
      "SELECT count(*) FILTER (WHERE state = 'QUEUED')::int AS queued, count(*) FILTER (WHERE state = 'RUNNING')::int AS running FROM tasks WHERE org_id = $1",
      [org.id],
    );
    const workers = await db.query("SELECT count(*) FILTER (WHERE last_heartbeat_at > now() - interval '1 minute')::int AS online, count(*)::int AS total FROM workers");
    const coverage = await db.query(
      `SELECT DISTINCT ON (cr.project_id) cr.project_id, p.name, cr.created_at, cr.line_covered, cr.line_total, cr.branch_covered, cr.branch_total, cr.toggle_covered, cr.toggle_total, cr.functional_covered, cr.functional_total
         FROM coverage_runs cr JOIN projects p ON p.id = cr.project_id WHERE cr.org_id = $1 AND cr.task_id IS NULL ORDER BY cr.project_id, cr.created_at DESC`,
      [org.id],
    );
    return {
      recentJobs: recent.rows,
      tests7d: rates.rows[0],
      usage7d: Object.fromEntries(usage.rows.map((u) => [u.kind, u.q])),
      queue: queue.rows[0],
      workers: workers.rows[0],
      coverage: coverage.rows.map((c) => ({ projectId: c.project_id, project: c.name, at: c.created_at, coverage: covSummary(c) })),
    };
  });
}
