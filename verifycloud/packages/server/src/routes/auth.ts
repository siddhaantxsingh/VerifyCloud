// Authentication: registration, login/logout, email verification, personal
// access tokens, GitHub OAuth login.
import { randomBytes, randomUUID } from "node:crypto";

import { Type as T } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { clearSessionCookie, parseCookies, requireUser, SCOPES, setSessionCookie, type Scope } from "../access.js";
import type { Ctx } from "../app.js";
import { audit } from "../audit.js";
import { hashPassword, newToken, safeEqual, sha256, verifyPassword } from "../crypto.js";
import { tx } from "../db.js";
import { AppError, E } from "../errors.js";
import { fixedWindow } from "../ratelimit.js";

const Email = T.String({ format: "email", maxLength: 254 });
const Password = T.String({ minLength: 10, maxLength: 200 });

export async function createSession(ctx: Ctx, req: FastifyRequest, userId: string) {
  const { token, hash } = newToken("sess");
  await ctx.db.query(
    "INSERT INTO sessions (id, user_id, token_hash, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => $6))",
    [randomUUID(), userId, hash, req.ip, String(req.headers["user-agent"] ?? "").slice(0, 300), ctx.cfg.sessionTtlHours],
  );
  return token;
}

async function limit(ctx: Ctx, key: string) {
  const r = await fixedWindow(ctx.db, key, ctx.cfg.limits.authRatePerMinute, 60);
  if (!r.ok) {
    ctx.metrics.rateLimited.inc({ kind: "auth" });
    throw E.rateLimited(r.retryAfter);
  }
}

async function sendVerification(ctx: Ctx, userId: string, email: string) {
  const token = randomBytes(32).toString("base64url");
  await ctx.db.query("INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1,$2,'verify_email', now() + interval '24 hours')", [sha256(token), userId]);
  await ctx.mailer.send({
    to: email,
    subject: "Verify your VerifyCloud email address",
    text: `Open this link to verify your email address (valid for 24 hours):\n${ctx.cfg.publicUrl}/verify-email?token=${token}\n\nIf you did not create an account, ignore this message.`,
  });
}

export async function authRoutes(api: FastifyInstance, ctx: Ctx) {
  const { db, cfg } = ctx;

  api.post(
    "/auth/register",
    { schema: { tags: ["auth"], summary: "Create an account", body: T.Object({ email: Email, password: Password, name: T.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }) } },
    async (req, reply) => {
      if (!cfg.allowRegistration || cfg.publicDemo) throw E.forbidden("registration is disabled on this instance");
      await limit(ctx, `register:${req.ip}`);
      const b = req.body as { email: string; password: string; name: string };
      const id = randomUUID();
      const hash = await hashPassword(b.password);
      try {
        await tx(db, async (c) => {
          await c.query("INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)", [id, b.email.toLowerCase(), b.name.trim(), hash]);
          await audit(c, req, { label: b.email }, { orgId: null, action: "user.register", targetType: "user", targetId: id });
        });
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw E.conflict("EMAIL_TAKEN", "an account with this email already exists");
        throw e;
      }
      await sendVerification(ctx, id, b.email);
      if (!cfg.requireEmailVerification) setSessionCookie(reply, await createSession(ctx, req, id), cfg.sessionTtlHours, cfg.cookieSecure);
      return reply.status(201).send({ user: { id, email: b.email.toLowerCase(), name: b.name.trim(), emailVerified: false }, verificationRequired: cfg.requireEmailVerification });
    },
  );

  api.post(
    "/auth/login",
    { schema: { tags: ["auth"], summary: "Log in (sets a session cookie)", body: T.Object({ email: Email, password: T.String({ maxLength: 200 }) }, { additionalProperties: false }) } },
    async (req, reply) => {
      const b = req.body as { email: string; password: string };
      await limit(ctx, `login-ip:${req.ip}`);
      await limit(ctx, `login-email:${b.email.toLowerCase()}`);
      const u = (await db.query("SELECT * FROM users WHERE email = $1 AND disabled_at IS NULL", [b.email.toLowerCase()])).rows[0];
      const ok = await verifyPassword(b.password, u?.password_hash ?? null);
      if (!u || !ok) {
        await audit(db, req, { label: b.email.toLowerCase() }, { orgId: null, action: "user.login_failed", metadata: { email: b.email.toLowerCase() } });
        throw new AppError(401, "INVALID_CREDENTIALS", "wrong email or password");
      }
      if (cfg.requireEmailVerification && !u.email_verified_at) throw E.forbidden("verify your email address before logging in");
      setSessionCookie(reply, await createSession(ctx, req, u.id), cfg.sessionTtlHours, cfg.cookieSecure);
      await audit(db, req, { label: u.email }, { orgId: null, action: "user.login", targetType: "user", targetId: u.id });
      return { user: { id: u.id, email: u.email, name: u.name, emailVerified: Boolean(u.email_verified_at) } };
    },
  );

  api.post("/auth/logout", { schema: { tags: ["auth"], summary: "Log out (deletes the session)" } }, async (req, reply) => {
    const p = req.principal;
    if (p?.kind === "user" && p.sessionId) await db.query("DELETE FROM sessions WHERE id = $1", [p.sessionId]);
    clearSessionCookie(reply, cfg.cookieSecure);
    return { ok: true };
  });

  api.post(
    "/auth/verify-email",
    { schema: { tags: ["auth"], summary: "Confirm an email address with the emailed token", body: T.Object({ token: T.String({ minLength: 20, maxLength: 200 }) }, { additionalProperties: false }) } },
    async (req) => {
      const { token } = req.body as { token: string };
      const r = await db.query(
        "UPDATE email_tokens SET used_at = now() WHERE token_hash = $1 AND purpose = 'verify_email' AND used_at IS NULL AND expires_at > now() RETURNING user_id",
        [sha256(token)],
      );
      if (!r.rows[0]) throw E.validation("invalid or expired verification token");
      await db.query("UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1", [r.rows[0].user_id]);
      return { ok: true };
    },
  );

  api.post("/auth/resend-verification", { schema: { tags: ["auth"], summary: "Send the verification email again" } }, async (req) => {
    const u = requireUser(req);
    await limit(ctx, `verify:${u.userId}`);
    await sendVerification(ctx, u.userId, u.email);
    return { ok: true };
  });

  api.get("/me", { schema: { tags: ["auth"], summary: "Current user and organizations" } }, async (req) => {
    const p = req.principal;
    if (!p) throw E.unauthenticated();
    if (p.kind === "org_key") {
      const o = (await db.query("SELECT id, slug, name, plan FROM organizations WHERE id = $1", [p.orgId])).rows[0];
      return { apiKey: { id: p.tokenId, role: p.role, scopes: p.scopes }, organizations: [{ ...o, role: p.role }] };
    }
    const u = (await db.query("SELECT id, email, name, email_verified_at, github_login, platform_admin FROM users WHERE id = $1", [p.userId])).rows[0];
    const orgs = (await db.query("SELECT o.id, o.slug, o.name, o.plan, o.is_demo, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY o.name", [p.userId])).rows;
    return {
      user: { id: u.id, email: u.email, name: u.name, emailVerified: Boolean(u.email_verified_at), githubLogin: u.github_login, platformAdmin: u.platform_admin },
      organizations: orgs,
      token: p.tokenId ? { id: p.tokenId, scopes: p.scopes } : null,
      features: { githubLogin: ctx.github.oauthConfigured, githubApp: ctx.github.configured, publicDemo: cfg.publicDemo, email: ctx.mailer.configured },
    };
  });

  // -------------------------------------------------- personal access tokens
  api.get("/me/tokens", { schema: { tags: ["auth"], summary: "List personal access tokens" } }, async (req) => {
    const u = requireUser(req);
    const r = await db.query("SELECT id, name, prefix, scopes, expires_at, last_used_at, revoked_at, created_at FROM api_tokens WHERE kind = 'pat' AND user_id = $1 ORDER BY created_at DESC", [u.userId]);
    return { tokens: r.rows };
  });

  api.post(
    "/me/tokens",
    {
      schema: {
        tags: ["auth"],
        summary: "Create a personal access token (shown once)",
        body: T.Object(
          { name: T.String({ minLength: 1, maxLength: 100 }), scopes: T.Array(T.Union(SCOPES.map((s) => T.Literal(s))), { minItems: 1, maxItems: 3 }), expiresInDays: T.Optional(T.Integer({ minimum: 1, maximum: 365 })) },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const u = requireUser(req);
      if (u.tokenId) throw E.forbidden("tokens cannot create tokens; use a browser session");
      const b = req.body as { name: string; scopes: Scope[]; expiresInDays?: number };
      const { token, hash, prefix } = newToken("pat");
      const id = randomUUID();
      await db.query(
        "INSERT INTO api_tokens (id, kind, user_id, name, prefix, token_hash, scopes, expires_at) VALUES ($1,'pat',$2,$3,$4,$5,$6, now() + make_interval(days => $7))",
        [id, u.userId, b.name, prefix, hash, [...new Set(b.scopes)], b.expiresInDays ?? 90],
      );
      await audit(db, req, u, { orgId: null, action: "token.create", targetType: "api_token", targetId: id, metadata: { scopes: b.scopes } });
      return reply.status(201).send({ id, token, prefix, scopes: b.scopes });
    },
  );

  api.delete("/me/tokens/:id", { schema: { tags: ["auth"], summary: "Revoke a personal access token", params: T.Object({ id: T.String({ format: "uuid" }) }) } }, async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    const r = await db.query("UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND kind = 'pat' AND revoked_at IS NULL", [id, u.userId]);
    if (!r.rowCount) throw E.notFound("token");
    await audit(db, req, u, { orgId: null, action: "token.revoke", targetType: "api_token", targetId: id });
    return { ok: true };
  });

  // -------------------------------------------------- GitHub OAuth
  api.get("/auth/github/start", { schema: { tags: ["auth"], summary: "Start GitHub login (redirect)" } }, async (req, reply) => {
    if (!ctx.github.oauthConfigured) throw E.unavailable("GitHub login is not configured");
    const state = randomBytes(24).toString("base64url");
    const linkUser = req.principal?.kind === "user" ? req.principal.userId : null;
    await db.query("INSERT INTO oauth_states (state_hash, purpose, user_id, expires_at) VALUES ($1,'github_login',$2, now() + interval '10 minutes')", [sha256(state), linkUser]);
    // bind the state to this browser: the callback must present the same value
    // in a cookie, so a callback link crafted by someone else cannot log the
    // victim into the attacker's account (login CSRF, audit S5)
    reply.header("Set-Cookie", `vc_oauth=${state}; Path=/api/v1/auth/github; HttpOnly; SameSite=Lax; Max-Age=600${cfg.cookieSecure ? "; Secure" : ""}`);
    return reply.redirect(ctx.github.oauthAuthorizeUrl(state, `${cfg.publicUrl}/api/v1/auth/github/callback`));
  });

  api.get(
    "/auth/github/callback",
    { schema: { tags: ["auth"], summary: "GitHub OAuth callback", querystring: T.Object({ code: T.String({ maxLength: 200 }), state: T.String({ maxLength: 200 }) }) } },
    async (req, reply) => {
      const { code, state } = req.query as { code: string; state: string };
      const bound = parseCookies(req.headers.cookie).vc_oauth;
      if (!bound || !safeEqual(bound, state)) throw E.validation("this sign-in was started in a different browser; start again");
      reply.header("Set-Cookie", `vc_oauth=; Path=/api/v1/auth/github; HttpOnly; SameSite=Lax; Max-Age=0${cfg.cookieSecure ? "; Secure" : ""}`);
      const st = (await db.query("DELETE FROM oauth_states WHERE state_hash = $1 AND expires_at > now() RETURNING user_id", [sha256(state)])).rows[0];
      if (!st) throw E.validation("invalid or expired OAuth state");
      const gh = await ctx.github.oauthUser(code, `${cfg.publicUrl}/api/v1/auth/github/callback`);
      let userId: string;
      const existing = (await db.query("SELECT id FROM users WHERE github_user_id = $1", [gh.id])).rows[0];
      if (st.user_id) {
        // linking to the logged-in account
        if (existing && existing.id !== st.user_id) throw E.conflict("GITHUB_ALREADY_LINKED", "this GitHub account is linked to another user");
        await db.query("UPDATE users SET github_user_id = $2, github_login = $3 WHERE id = $1", [st.user_id, gh.id, gh.login]);
        userId = st.user_id;
      } else if (existing) userId = existing.id;
      else {
        if (!cfg.allowRegistration || cfg.publicDemo) throw E.forbidden("registration is disabled on this instance");
        if (!gh.email) throw E.validation("your GitHub account has no verified email address");
        const byEmail = (await db.query("SELECT id FROM users WHERE email = $1", [gh.email.toLowerCase()])).rows[0];
        // never merge into an existing password account automatically (account takeover risk)
        if (byEmail) throw E.conflict("EMAIL_TAKEN", "an account with this email exists; log in and link GitHub from settings");
        userId = randomUUID();
        await db.query("INSERT INTO users (id, email, name, github_user_id, github_login, email_verified_at) VALUES ($1,$2,$3,$4,$5, now())", [userId, gh.email.toLowerCase(), gh.name, gh.id, gh.login]);
      }
      await audit(db, req, { label: `github:${gh.login}` }, { orgId: null, action: "user.login_github", targetType: "user", targetId: userId });
      setSessionCookie(reply, await createSession(ctx, req, userId), cfg.sessionTtlHours, cfg.cookieSecure);
      return reply.redirect("/"); // "/dashboard" was not a route of the web app
    },
  );
}
