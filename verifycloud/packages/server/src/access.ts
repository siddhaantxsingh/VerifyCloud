// Authentication (who is calling) and authorization (what they may do).
//
// Rules (docs/security.md):
//  * identity comes only from a session cookie or a bearer token, never from
//    request parameters;
//  * every tenant resource is looked up together with the caller's access;
//    a caller without access gets 404 (indistinguishable from nonexistent),
//    a member with too low a role gets 403;
//  * tokens are limited by scopes: a PAT never exceeds its owner's role, an
//    organization key never leaves its organization.
import type { FastifyReply, FastifyRequest } from "fastify";

import { roleAtLeast, type Role } from "@verifycloud/shared";

import { sha256 } from "./crypto.js";
import type { Q } from "./db.js";
import { E } from "./errors.js";

export type Scope = "read" | "write" | "admin";
export const SCOPES: Scope[] = ["read", "write", "admin"];

export type Principal =
  | { kind: "user"; userId: string; email: string; name: string; platformAdmin: boolean; sessionId?: string; tokenId?: string; scopes: Scope[] | null; label: string }
  | { kind: "org_key"; tokenId: string; orgId: string; role: Role; scopes: Scope[]; label: string; userId: null };

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export const SESSION_COOKIE = "vc_session";

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* malformed percent-encoding: ignore the cookie (was a 500) */
    }
  }
  return out;
}

/** Resolve the caller from a session cookie or Authorization: Bearer token. */
export async function authenticate(q: Q, req: FastifyRequest): Promise<Principal | undefined> {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    const r = await q.query(
      `SELECT t.id, t.kind, t.org_id, t.role, t.scopes, t.name, u.id AS user_id, u.email, u.name AS user_name, u.platform_admin, u.disabled_at,
              m.role AS creator_role
         FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id
         LEFT JOIN memberships m ON t.kind = 'org_key' AND m.org_id = t.org_id AND m.user_id = t.user_id
        WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())`,
      [sha256(token)],
    );
    const t = r.rows[0];
    if (!t) return undefined;
    void q.query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [t.id]).catch(() => {});
    if (t.kind === "org_key") {
      // An organization key never exceeds its creator's current role, and stops
      // working when the creator leaves the organization or is disabled
      // (audit S1: keys used to outlive the admin who minted them).
      if (!t.creator_role || t.disabled_at) return undefined;
      const role: Role = roleAtLeast(t.creator_role, t.role) ? t.role : t.creator_role;
      return { kind: "org_key", tokenId: t.id, orgId: t.org_id, role, scopes: t.scopes, label: `api-key:${t.name}`, userId: null };
    }
    if (t.disabled_at) return undefined;
    return { kind: "user", userId: t.user_id, email: t.email, name: t.user_name, platformAdmin: t.platform_admin, tokenId: t.id, scopes: t.scopes, label: `${t.email} (token ${t.name})` };
  }
  const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!cookie) return undefined;
  const r = await q.query(
    `SELECT s.id, u.id AS user_id, u.email, u.name, u.platform_admin FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [sha256(cookie)],
  );
  const s = r.rows[0];
  if (!s) return undefined;
  return { kind: "user", userId: s.user_id, email: s.email, name: s.name, platformAdmin: s.platform_admin, sessionId: s.id, scopes: null, label: s.email };
}

export function requireUser(req: FastifyRequest): Extract<Principal, { kind: "user" }> {
  const p = req.principal;
  if (!p) throw E.unauthenticated();
  if (p.kind !== "user") throw E.forbidden("this endpoint requires a user, not an organization API key");
  return p;
}

export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw E.unauthenticated();
  return req.principal;
}

/** Cap a role by token scopes. */
function capByScopes(role: Role, scopes: Scope[] | null): Role {
  if (scopes === null) return role;
  if (scopes.includes("admin")) return role;
  if (scopes.includes("write")) return roleAtLeast(role, "engineer") ? "engineer" : role;
  return "viewer";
}

/** The caller's effective role in an organization, or throws 404. */
export async function orgRole(q: Q, p: Principal, orgId: string): Promise<Role> {
  if (p.kind === "org_key") {
    if (p.orgId !== orgId) throw E.notFound("organization");
    return capByScopes(p.role, p.scopes);
  }
  const r = await q.query("SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2", [orgId, p.userId]);
  if (!r.rows[0]) throw E.notFound("organization");
  return capByScopes(r.rows[0].role, p.scopes);
}

export async function requireOrgRole(q: Q, p: Principal, orgId: string, need: Role): Promise<Role> {
  const role = await orgRole(q, p, orgId);
  if (!roleAtLeast(role, need)) throw E.forbidden(`requires role ${need} or higher`);
  return role;
}

/** Resolve an organization by id or slug and the caller's role in it. */
export async function resolveOrg(q: Q, p: Principal, idOrSlug: string, need: Role = "viewer") {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
  const r = await q.query(`SELECT * FROM organizations WHERE ${isUuid ? "id = $1" : "slug = $1"}`, [idOrSlug]);
  const org = r.rows[0];
  if (!org) throw E.notFound("organization");
  const role = await requireOrgRole(q, p, org.id, need);
  return { org, role };
}

/** Load a tenant-owned row and check the caller's role in its organization. */
export async function loadOwned<T extends { org_id: string } = { org_id: string; [k: string]: any }>(
  q: Q,
  p: Principal,
  what: string,
  sql: string,
  id: string,
  need: Role = "viewer",
): Promise<{ row: T; role: Role }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw E.notFound(what);
  const r = await q.query(sql, [id]);
  const row = r.rows[0] as T | undefined;
  if (!row) throw E.notFound(what);
  let role: Role;
  try {
    role = await orgRole(q, p, row.org_id);
  } catch {
    throw E.notFound(what); // other tenant: same answer as "does not exist"
  }
  if (!roleAtLeast(role, need)) throw E.forbidden(`requires role ${need} or higher`);
  return { row, role };
}

export const loadProject = (q: Q, p: Principal, id: string, need: Role = "viewer") =>
  loadOwned<{ org_id: string; id: string; [k: string]: unknown }>(q, p, "project", "SELECT p.*, o.is_demo, o.plan FROM projects p JOIN organizations o ON o.id = p.org_id WHERE p.id = $1", id, need);
export const loadJob = (q: Q, p: Principal, id: string, need: Role = "viewer") =>
  loadOwned<{ org_id: string; id: string; [k: string]: unknown }>(q, p, "job", "SELECT * FROM jobs WHERE id = $1", id, need);
export const loadTask = (q: Q, p: Principal, id: string, need: Role = "viewer") =>
  loadOwned<{ org_id: string; id: string; [k: string]: unknown }>(q, p, "task", "SELECT * FROM tasks WHERE id = $1", id, need);
export const loadArtifact = (q: Q, p: Principal, id: string, need: Role = "viewer") =>
  loadOwned<{ org_id: string; id: string; [k: string]: unknown }>(q, p, "artifact", "SELECT * FROM artifacts WHERE id = $1", id, need);

/** Requests authenticated by cookie must come from an allowed origin (CSRF defense in addition to SameSite=Lax). */
export function checkOrigin(req: FastifyRequest, allowed: string[], publicUrl: string) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  if (req.headers.authorization?.startsWith("Bearer ")) return; // bearer tokens are not sent automatically by browsers
  if (!parseCookies(req.headers.cookie)[SESSION_COOKIE]) return;
  const origin = req.headers.origin;
  const host = req.headers.host;
  const ok = origin && (allowed.includes(origin) || origin === publicUrl || (host && (origin === `http://${host}` || origin === `https://${host}`)));
  if (!ok) throw E.forbidden("cross-origin request refused");
}

export function setSessionCookie(reply: FastifyReply, token: string, ttlHours: number, secure: boolean) {
  reply.header(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttlHours * 3600}${secure ? "; Secure" : ""}`,
  );
}
export function clearSessionCookie(reply: FastifyReply, secure: boolean) {
  reply.header("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`);
}
