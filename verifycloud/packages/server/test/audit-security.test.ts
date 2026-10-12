// Security regression tests written during the 2026-10-08 audit. Each
// reproduces a finding from the code review; they failed before the fixes.
import { createServer, type Server } from "node:http";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertProductionConfig, loadConfig } from "../src/config.js";
import { isPublicAddress, validateTargetUrl } from "../src/netguard.js";
import { Client, createTestDatabase, FakeWorker, minimalConfig, newUser, orgWithProject, snapshotOf, startServer, uploadSnapshot, waitFor, type TestServer } from "./helpers.js";

let db: { url: string; drop: () => Promise<void> };
let s: TestServer;
let gh: Server;
let ghPort = 0;
beforeAll(async () => {
  // minimal fake GitHub OAuth + API for the login CSRF test
  gh = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/login/oauth/access_token")) return res.end(JSON.stringify({ access_token: "gho_fake" }));
    if (req.url === "/user") return res.end(JSON.stringify({ id: 9001, login: "attacker-gh", name: "Attacker" }));
    if (req.url === "/user/emails") return res.end(JSON.stringify([{ email: "attacker@example.com", primary: true, verified: true }]));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => gh.listen(0, "127.0.0.1", () => r()));
  ghPort = (gh.address() as { port: number }).port;
  db = await createTestDatabase();
  s = await startServer(db.url, {
    limits: { jobCreatePerMinute: 3 } as any,
    github: { apiUrl: `http://127.0.0.1:${ghPort}`, oauthUrl: `http://127.0.0.1:${ghPort}`, oauthClientId: "cid", oauthClientSecret: "csecret" } as any,
  });
});
afterAll(async () => {
  await s.app.close();
  await db.drop();
  gh.close();
});

const verify = (email: string) => s.db.query("UPDATE users SET email_verified_at = now() WHERE email = $1", [email]);

describe("audit: organization privilege boundaries (S1, S2, S11, S12)", () => {
  it("S1: an admin-role org API key cannot add members (keys do not manage people)", async () => {
    const owner = await orgWithProject(s.base, "own");
    const key = (await owner.c.post(`/api/v1/orgs/${owner.slug}/api-keys`, { name: "ci", role: "admin", scopes: ["read", "write", "admin"] })).json.token;
    const victim = await newUser(s.base, "attacker");
    await verify(victim.email);
    const k = new Client(s.base);
    k.token = key;
    const r = await k.post(`/api/v1/orgs/${owner.slug}/members`, { email: victim.email, role: "admin" });
    expect(r.status).toBe(403);
  });

  it("S1: a human admin cannot grant admin by adding a member (only owners grant admin)", async () => {
    const owner = await orgWithProject(s.base, "own");
    const admin = await newUser(s.base, "adm");
    await verify(admin.email);
    expect((await owner.c.post(`/api/v1/orgs/${owner.slug}/members`, { email: admin.email, role: "admin" })).status).toBe(201);
    const alt = await newUser(s.base, "alt");
    await verify(alt.email);
    expect((await admin.c.post(`/api/v1/orgs/${owner.slug}/members`, { email: alt.email, role: "admin" })).status).toBe(403);
    expect((await admin.c.post(`/api/v1/orgs/${owner.slug}/members`, { email: alt.email, role: "engineer" })).status).toBe(201);
  });

  it("S1: an org key is capped by its creator's current role and dies when the creator leaves", async () => {
    const owner = await orgWithProject(s.base, "own");
    const admin = await newUser(s.base, "adm2");
    await verify(admin.email);
    await owner.c.post(`/api/v1/orgs/${owner.slug}/members`, { email: admin.email, role: "admin" });
    const key = (await admin.c.post(`/api/v1/orgs/${owner.slug}/api-keys`, { name: "persist", role: "admin", scopes: ["read", "write", "admin"] })).json.token;
    const k = new Client(s.base);
    k.token = key;
    expect((await k.get(`/api/v1/orgs/${owner.slug}/api-keys`)).status).toBe(200);
    await owner.c.patch(`/api/v1/orgs/${owner.slug}/members/${admin.id}`, { role: "viewer" });
    expect((await k.get(`/api/v1/orgs/${owner.slug}/api-keys`)).status).toBe(403);
    expect((await k.get(`/api/v1/orgs/${owner.slug}/projects`)).status).toBe(200); // still a viewer
    await owner.c.del(`/api/v1/orgs/${owner.slug}/members/${admin.id}`);
    expect((await k.get(`/api/v1/orgs/${owner.slug}/projects`)).status).toBe(401);
  });

  it("S2: accounts with an unverified email cannot be added to an organization", async () => {
    const owner = await orgWithProject(s.base, "own");
    const squatter = await newUser(s.base, "squat");
    s.app.ctx.cfg.requireEmailVerification = true;
    try {
      const r = await owner.c.post(`/api/v1/orgs/${owner.slug}/members`, { email: squatter.email, role: "engineer" });
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe("EMAIL_NOT_VERIFIED");
    } finally {
      s.app.ctx.cfg.requireEmailVerification = false;
    }
  });

  it("S11: a read-only personal token cannot create organizations or revoke tokens", async () => {
    const u = await orgWithProject(s.base, "ro");
    const ro = (await u.c.post("/api/v1/me/tokens", { name: "ro", scopes: ["read"] })).json;
    const other = (await u.c.post("/api/v1/me/tokens", { name: "other", scopes: ["write"] })).json;
    const t = new Client(s.base);
    t.token = ro.token;
    expect((await t.get("/api/v1/me")).status).toBe(200);
    expect((await t.post("/api/v1/orgs", { name: "Evil", slug: `evil-${Date.now()}` })).status).toBe(403);
    expect((await t.del(`/api/v1/me/tokens/${other.id}`)).status).toBe(403);
  });

  it("S12: two owners demoting each other concurrently cannot leave the organization without an owner", async () => {
    const a = await orgWithProject(s.base, "ownA");
    const b = await newUser(s.base, "ownB");
    await verify(b.email);
    await a.c.post(`/api/v1/orgs/${a.slug}/members`, { email: b.email, role: "owner" });
    for (let i = 0; i < 5; i++) {
      await s.db.query("UPDATE memberships SET role = 'owner' WHERE org_id = $1", [a.org.id]);
      await Promise.all([a.c.patch(`/api/v1/orgs/${a.slug}/members/${b.id}`, { role: "engineer" }), b.c.patch(`/api/v1/orgs/${a.slug}/members/${a.id}`, { role: "engineer" })]);
      const owners = (await s.db.query("SELECT count(*)::int AS n FROM memberships WHERE org_id = $1 AND role = 'owner'", [a.org.id])).rows[0].n;
      expect(owners).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("audit: request hardening", () => {
  it("S8: re-runs and patch verifications count against the job-creation rate limit", async () => {
    const o = await orgWithProject(s.base, "rl");
    await uploadSnapshot(o.c, o.project.id, snapshotOf({ "verifycloud.yaml": minimalConfig(), "rtl/a.sv": "module a; endmodule\n", "tb/tb.sv": "module tb; endmodule\n" }));
    const j = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke" })).json.job;
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await o.c.post(`/api/v1/jobs/${j.id}/rerun`)).status);
    expect(statuses).toContain(429);
  });

  it("malformed cookies and UUID-shaped slugs are client errors, not 500s", async () => {
    const r1 = await fetch(`${s.base}/api/v1/me`, { headers: { Cookie: "vc_session=%E0%A4%A" } });
    expect(r1.status).toBe(401);
    const u = await newUser(s.base, "slug");
    const r2 = await u.c.get("/api/v1/orgs/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaz");
    expect(r2.status).toBe(404);
    const r3 = await u.c.get("/api/v1/orgs/------------------------------------");
    expect(r3.status).toBe(404);
  });

  it("S5: the GitHub OAuth callback only completes in the browser that started the flow (login CSRF)", async () => {
    // attacker starts the flow in their own browser and keeps the state
    const start = await fetch(`${s.base}/api/v1/auth/github/start`, { redirect: "manual" });
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const attackerCookie = (start.headers.get("set-cookie") ?? "").split(";")[0]!;
    // victim's browser follows the attacker's callback link: no matching cookie → refused
    const victim = await fetch(`${s.base}/api/v1/auth/github/callback?code=c0de&state=${state}`, { redirect: "manual" });
    expect(victim.status).toBe(400);
    expect(victim.headers.get("set-cookie") ?? "").not.toMatch(/vc_session=[^;]+/);
    // the browser that started the flow completes it
    const start2 = await fetch(`${s.base}/api/v1/auth/github/start`, { redirect: "manual" });
    const state2 = new URL(start2.headers.get("location")!).searchParams.get("state")!;
    const cookie2 = (start2.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(attackerCookie).toMatch(/^vc_oauth=/);
    const ok = await fetch(`${s.base}/api/v1/auth/github/callback?code=c0de&state=${state2}`, { redirect: "manual", headers: { Cookie: cookie2 } });
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/");
  });
});

describe("audit: client address behind proxies (S3)", () => {
  it("TRUST_PROXY=true trusts one hop only: clients cannot pick their IP via X-Forwarded-For", async () => {
    const { trustProxySetting } = await import("../src/app.js");
    const f = trustProxySetting("true") as (a: string, hop: number) => boolean;
    expect(typeof f).toBe("function");
    expect(f("10.0.0.1", 0)).toBe(true);
    expect(f("1.2.3.4", 1)).toBe(false);
    expect(trustProxySetting(undefined)).toBe(false);
    expect(trustProxySetting("10.0.0.0/8, 192.168.1.1")).toEqual(["10.0.0.0/8", "192.168.1.1"]);
    // end to end: rotating the client-controlled leftmost entry does not evade the per-IP login limit
    process.env.TRUST_PROXY = "true";
    const db2 = await createTestDatabase();
    const p = await startServer(db2.url, { limits: { authRatePerMinute: 3 } as any });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await fetch(`${p.base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: p.base, "X-Forwarded-For": `203.0.113.${i}, 198.51.100.7` }, body: JSON.stringify({ email: `nobody${i}@example.com`, password: "wrong password!" }) });
        codes.push(r.status);
      }
      expect(codes).toContain(429);
    } finally {
      delete process.env.TRUST_PROXY;
      await p.app.close();
      await db2.drop();
    }
  });
});

describe("audit: SSRF guard (S6)", () => {
  it("refuses IPv6 forms that embed private IPv4 addresses (NAT64, 6to4, IPv4-compatible, mapped)", () => {
    for (const a of ["64:ff9b::a9fe:a9fe", "64:ff9b::7f00:1", "64:ff9b:1::a00:1", "2002:a9fe:a9fe::1", "2002:7f00:1::", "::a9fe:a9fe", "::7f00:1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "fc00::1", "fe80::1", "ff02::1", "100::1", "2001:db8::1", "0.0.0.0", "100.64.0.1", "169.254.169.254", "127.1.2.3"])
      expect(isPublicAddress(a), a).toBe(false);
    for (const a of ["2606:4700:4700::1111", "8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"]) expect(isPublicAddress(a), a).toBe(true);
    process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = "";
    expect(() => validateTargetUrl("https://[64:ff9b::a9fe:a9fe]/x", false)).toThrow();
    expect(() => validateTargetUrl("https://[2002:a9fe:a9fe::1]/x", false)).toThrow();
  });
});

describe("audit: production configuration (S4)", () => {
  it("requires METRICS_TOKEN in production (behind a same-host proxy every client is loopback)", () => {
    const keep = { ...process.env };
    try {
      process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
      process.env.WORKER_REGISTRATION_TOKEN = "x".repeat(40);
      process.env.COOKIE_SECURE = "true";
      process.env.PUBLIC_URL = "https://vc.example.com";
      delete process.env.METRICS_TOKEN;
      const cfg = loadConfig({});
      expect(() => assertProductionConfig(cfg)).toThrow(/METRICS_TOKEN/);
      process.env.METRICS_TOKEN = "m".repeat(32);
      expect(() => assertProductionConfig(loadConfig({}))).not.toThrow();
    } finally {
      process.env = keep;
    }
  });
});

void pg;
void FakeWorker;
void waitFor;
