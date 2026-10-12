// Organizations: membership, roles, organization API keys, usage, quotas, audit log.
import { randomUUID } from "node:crypto";

import { Type as T } from "@sinclair/typebox";
import { roleAtLeast, type Role } from "@verifycloud/shared";
import type { FastifyInstance } from "fastify";

import { requirePrincipal, requireUser, resolveOrg, SCOPES, type Scope } from "../access.js";
import type { Ctx } from "../app.js";
import { orgStorageUsage } from "../artifacts.js";
import { audit } from "../audit.js";
import { newToken } from "../crypto.js";
import { tx } from "../db.js";
import { E } from "../errors.js";

const Org = T.Object({ org: T.String({ maxLength: 64 }) });
const RoleT = T.Union([T.Literal("owner"), T.Literal("admin"), T.Literal("engineer"), T.Literal("viewer")]);

export async function orgRoutes(api: FastifyInstance, ctx: Ctx) {
  const { db, cfg } = ctx;

  api.get("/orgs", { schema: { tags: ["organizations"], summary: "Organizations of the caller" } }, async (req) => {
    const p = requirePrincipal(req);
    if (p.kind === "org_key") return { organizations: (await db.query("SELECT id, slug, name, plan FROM organizations WHERE id = $1", [p.orgId])).rows.map((o) => ({ ...o, role: p.role })) };
    const r = await db.query("SELECT o.id, o.slug, o.name, o.plan, o.is_demo, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY o.name", [p.userId]);
    return { organizations: r.rows };
  });

  api.post(
    "/orgs",
    { schema: { tags: ["organizations"], summary: "Create an organization (caller becomes owner)", body: T.Object({ name: T.String({ minLength: 1, maxLength: 100 }), slug: T.String({ pattern: "^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$" }) }, { additionalProperties: false }) } },
    async (req, reply) => {
      const u = requireUser(req);
      if (ctx.cfg.publicDemo) throw E.demo();
      const b = req.body as { name: string; slug: string };
      const id = randomUUID();
      try {
        await tx(db, async (c) => {
          await c.query("INSERT INTO organizations (id, slug, name, plan) VALUES ($1,$2,$3,'free')", [id, b.slug, b.name]);
          await c.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,'owner')", [id, u.userId]);
          await audit(c, req, u, { orgId: id, action: "org.create", targetType: "organization", targetId: id });
        });
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw E.conflict("SLUG_TAKEN", "this organization slug is taken");
        throw e;
      }
      return reply.status(201).send({ organization: { id, slug: b.slug, name: b.name, plan: "free", role: "owner" } });
    },
  );

  api.get("/orgs/:org", { schema: { tags: ["organizations"], summary: "Organization details, plan and quotas", params: Org } }, async (req) => {
    const p = requirePrincipal(req);
    const { org, role } = await resolveOrg(db, p, (req.params as { org: string }).org);
    const plan = (await db.query("SELECT * FROM plans WHERE name = $1", [org.plan])).rows[0];
    const usage = await orgStorageUsage(db, org.id);
    const running = (await db.query("SELECT (SELECT count(*)::int FROM jobs WHERE org_id = $1 AND state = 'RUNNING') AS jobs, (SELECT count(*)::int FROM tasks WHERE org_id = $1 AND state = 'RUNNING') AS tasks", [org.id])).rows[0];
    return { organization: { ...org, role }, plan, usage: { storageBytes: usage.used, runningJobs: running.jobs, runningTasks: running.tasks } };
  });

  // -------------------------------------------------- members
  api.get("/orgs/:org/members", { schema: { tags: ["organizations"], summary: "List members", params: Org } }, async (req) => {
    const { org } = await resolveOrg(db, requirePrincipal(req), (req.params as { org: string }).org);
    const r = await db.query("SELECT u.id, u.email, u.name, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY u.email", [org.id]);
    return { members: r.rows };
  });

  api.post(
    "/orgs/:org/members",
    { schema: { tags: ["organizations"], summary: "Add an existing user by email", params: Org, body: T.Object({ email: T.String({ format: "email" }), role: RoleT }, { additionalProperties: false }) } },
    async (req, reply) => {
      // people management needs a person: organization API keys are for CI (audit S1)
      const p = requireUser(req);
      const { org, role: myRole } = await resolveOrg(db, p, (req.params as { org: string }).org, "admin");
      const b = req.body as { email: string; role: Role };
      // same rule as role changes: only owners grant owner or admin (audit S1)
      if ((b.role === "owner" || b.role === "admin") && myRole !== "owner") throw E.forbidden("only owners can add owners or admins");
      const u = (await db.query("SELECT id, email_verified_at FROM users WHERE email = $1", [b.email.toLowerCase()])).rows[0];
      // Do not reveal whether an email has an account to non-owners beyond this org's admins.
      if (!u) throw E.notFound("user");
      // An unverified account may belong to someone squatting the address
      // (audit S2). Enforced whenever this deployment can verify addresses
      // (email configured or verification required); without email there is
      // no way to verify, which docs/security.md lists as a residual risk.
      if (!u.email_verified_at && (cfg.requireEmailVerification || cfg.smtpUrl))
        throw E.conflict("EMAIL_NOT_VERIFIED", "this account has not verified its email address yet");
      try {
        await tx(db, async (c) => {
          await c.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,$3)", [org.id, u.id, b.role]);
          await audit(c, req, p, { orgId: org.id, action: "member.add", targetType: "user", targetId: u.id, metadata: { role: b.role } });
        });
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw E.conflict("ALREADY_MEMBER", "the user is already a member");
        throw e;
      }
      return reply.status(201).send({ ok: true });
    },
  );

  api.patch(
    "/orgs/:org/members/:userId",
    { schema: { tags: ["organizations"], summary: "Change a member's role", params: T.Object({ org: T.String(), userId: T.String({ format: "uuid" }) }), body: T.Object({ role: RoleT }, { additionalProperties: false }) } },
    async (req) => {
      const p = requireUser(req);
      const { org: slug, userId } = req.params as { org: string; userId: string };
      const { org, role: myRole } = await resolveOrg(db, p, slug, "admin");
      const { role } = req.body as { role: Role };
      await tx(db, async (c) => {
        // serialize owner changes per organization: lock every owner row before
        // counting, so two owners demoting each other cannot both succeed (audit S12)
        await c.query("SELECT 1 FROM memberships WHERE org_id = $1 AND role = 'owner' FOR UPDATE", [org.id]);
        const cur = (await c.query("SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2 FOR UPDATE", [org.id, userId])).rows[0];
        if (!cur) throw E.notFound("member");
        // admins manage engineers/viewers; only owners grant or remove owner/admin
        if ((role === "owner" || cur.role === "owner" || role === "admin" || cur.role === "admin") && myRole !== "owner") throw E.forbidden("only owners can change owner or admin roles");
        if (cur.role === "owner" && role !== "owner") {
          const owners = (await c.query("SELECT count(*)::int AS n FROM memberships WHERE org_id = $1 AND role = 'owner'", [org.id])).rows[0].n;
          if (owners <= 1) throw E.conflict("LAST_OWNER", "the organization must keep at least one owner");
        }
        await c.query("UPDATE memberships SET role = $3 WHERE org_id = $1 AND user_id = $2", [org.id, userId, role]);
        await audit(c, req, p, { orgId: org.id, action: "member.role_change", targetType: "user", targetId: userId, metadata: { from: cur.role, to: role } });
      });
      return { ok: true };
    },
  );

  api.delete("/orgs/:org/members/:userId", { schema: { tags: ["organizations"], summary: "Remove a member", params: T.Object({ org: T.String(), userId: T.String({ format: "uuid" }) }) } }, async (req) => {
    const p = requireUser(req);
    const { org: slug, userId } = req.params as { org: string; userId: string };
    const self = p.userId === userId;
    const { org, role: myRole } = await resolveOrg(db, p, slug, self ? "viewer" : "admin");
    await tx(db, async (c) => {
      await c.query("SELECT 1 FROM memberships WHERE org_id = $1 AND role = 'owner' FOR UPDATE", [org.id]);
      const cur = (await c.query("SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2 FOR UPDATE", [org.id, userId])).rows[0];
      if (!cur) throw E.notFound("member");
      if (!self && (cur.role === "owner" || cur.role === "admin") && myRole !== "owner") throw E.forbidden("only owners can remove owners or admins");
      if (cur.role === "owner" && (await c.query("SELECT count(*)::int AS n FROM memberships WHERE org_id = $1 AND role = 'owner'", [org.id])).rows[0].n <= 1)
        throw E.conflict("LAST_OWNER", "the organization must keep at least one owner");
      await c.query("DELETE FROM memberships WHERE org_id = $1 AND user_id = $2", [org.id, userId]);
      await audit(c, req, p, { orgId: org.id, action: "member.remove", targetType: "user", targetId: userId });
    });
    return { ok: true };
  });

  // -------------------------------------------------- organization API keys
  api.get("/orgs/:org/api-keys", { schema: { tags: ["organizations"], summary: "List organization API keys", params: Org } }, async (req) => {
    const { org } = await resolveOrg(db, requirePrincipal(req), (req.params as { org: string }).org, "admin");
    const r = await db.query("SELECT id, name, prefix, role, scopes, expires_at, last_used_at, revoked_at, created_at FROM api_tokens WHERE kind = 'org_key' AND org_id = $1 ORDER BY created_at DESC", [org.id]);
    return { apiKeys: r.rows };
  });

  api.post(
    "/orgs/:org/api-keys",
    {
      schema: {
        tags: ["organizations"],
        summary: "Create an organization API key for CI (shown once)",
        params: Org,
        body: T.Object(
          {
            name: T.String({ minLength: 1, maxLength: 100 }),
            role: T.Union([T.Literal("admin"), T.Literal("engineer"), T.Literal("viewer")]),
            scopes: T.Array(T.Union(SCOPES.map((s) => T.Literal(s))), { minItems: 1, maxItems: 3 }),
            expiresInDays: T.Optional(T.Integer({ minimum: 1, maximum: 365 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const u = requireUser(req);
      if (u.tokenId) throw E.forbidden("tokens cannot create keys; use a browser session");
      const { org, role: myRole } = await resolveOrg(db, u, (req.params as { org: string }).org, "admin");
      const b = req.body as { name: string; role: Role; scopes: Scope[]; expiresInDays?: number };
      if (!roleAtLeast(myRole, b.role)) throw E.forbidden("cannot create a key with a higher role than your own");
      const { token, hash, prefix } = newToken("key");
      const id = randomUUID();
      await tx(db, async (c) => {
        await c.query(
          "INSERT INTO api_tokens (id, kind, user_id, org_id, role, name, prefix, token_hash, scopes, expires_at) VALUES ($1,'org_key',$2,$3,$4,$5,$6,$7,$8, now() + make_interval(days => $9))",
          [id, u.userId, org.id, b.role, b.name, prefix, hash, [...new Set(b.scopes)], b.expiresInDays ?? 90],
        );
        await audit(c, req, u, { orgId: org.id, action: "api_key.create", targetType: "api_token", targetId: id, metadata: { role: b.role, scopes: b.scopes } });
      });
      return reply.status(201).send({ id, token, prefix, role: b.role, scopes: b.scopes });
    },
  );

  api.delete("/orgs/:org/api-keys/:id", { schema: { tags: ["organizations"], summary: "Revoke an organization API key", params: T.Object({ org: T.String(), id: T.String({ format: "uuid" }) }) } }, async (req) => {
    const p = requirePrincipal(req);
    const { org: slug, id } = req.params as { org: string; id: string };
    const { org } = await resolveOrg(db, p, slug, "admin");
    const r = await db.query("UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND org_id = $2 AND kind = 'org_key' AND revoked_at IS NULL", [id, org.id]);
    if (!r.rowCount) throw E.notFound("api key");
    await audit(db, req, p, { orgId: org.id, action: "api_key.revoke", targetType: "api_token", targetId: id });
    return { ok: true };
  });

  // -------------------------------------------------- usage ledger & audit
  api.get(
    "/orgs/:org/usage",
    { schema: { tags: ["organizations"], summary: "Usage ledger aggregated by kind and day", params: Org, querystring: T.Object({ days: T.Optional(T.Integer({ minimum: 1, maximum: 365 })) }) } },
    async (req) => {
      const { org } = await resolveOrg(db, requirePrincipal(req), (req.params as { org: string }).org, "admin");
      const days = (req.query as { days?: number }).days ?? 30;
      const r = await db.query(
        "SELECT date_trunc('day', created_at) AS day, kind, sum(quantity)::float AS quantity FROM usage_records WHERE org_id = $1 AND created_at > now() - make_interval(days => $2) GROUP BY 1, 2 ORDER BY 1",
        [org.id, days],
      );
      const totals = await db.query("SELECT kind, sum(quantity)::float AS quantity FROM usage_records WHERE org_id = $1 AND created_at > now() - make_interval(days => $2) GROUP BY kind", [org.id, days]);
      const storage = await orgStorageUsage(db, org.id);
      return { days, daily: r.rows, totals: Object.fromEntries(totals.rows.map((x) => [x.kind, x.quantity])), storage };
    },
  );

  api.get(
    "/orgs/:org/audit",
    {
      schema: {
        tags: ["organizations"],
        summary: "Audit log (owners and admins)",
        params: Org,
        querystring: T.Object({ before: T.Optional(T.Integer({ minimum: 1 })), limit: T.Optional(T.Integer({ minimum: 1, maximum: 200 })), action: T.Optional(T.String({ maxLength: 64 })) }),
      },
    },
    async (req) => {
      const { org } = await resolveOrg(db, requirePrincipal(req), (req.params as { org: string }).org, "admin");
      const q = req.query as { before?: number; limit?: number; action?: string };
      const params: unknown[] = [org.id];
      const conds = ["org_id = $1"];
      if (q.before) conds.push(`id < $${params.push(q.before)}`);
      if (q.action) conds.push(`action LIKE $${params.push(q.action.replace(/[%_]/g, "") + "%")}`);
      const limit = q.limit ?? 50;
      const r = await db.query(`SELECT id, actor_label, action, target_type, target_id, ip, request_id, metadata, created_at FROM audit_events WHERE ${conds.join(" AND ")} ORDER BY id DESC LIMIT ${limit}`, params);
      return { events: r.rows, nextBefore: r.rows.length === limit ? r.rows[r.rows.length - 1].id : null };
    },
  );
}
