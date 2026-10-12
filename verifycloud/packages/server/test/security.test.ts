// Authentication, authorization, multi-tenancy (IDOR / enumeration), token
// scopes, CSRF, input handling and information leakage.
import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client, createTestDatabase, FakeWorker, minimalConfig, newUser, orgWithProject, snapshotOf, startServer, uploadSnapshot, type TestServer } from "./helpers.js";

let db: { url: string; drop: () => Promise<void> };
let s: TestServer;
beforeAll(async () => {
  db = await createTestDatabase();
  s = await startServer(db.url);
});
afterAll(async () => {
  await s.app.close();
  await db.drop();
});

const files = { "verifycloud.yaml": minimalConfig(), "rtl/a.sv": "module a; endmodule\n", "tb/tb.sv": "module tb; a u(); endmodule\n" };

/** Org B with a project, a finished job, a failed task, artifacts, a patch. */
async function victim() {
  const b = await orgWithProject(s.base, "victim");
  await uploadSnapshot(b.c, b.project.id, snapshotOf(files));
  const job = (await b.c.post(`/api/v1/projects/${b.project.id}/jobs`, { regression: "smoke" })).json.job;
  const w = await new FakeWorker(s.base).register();
  let logArtifact = "";
  let failedTask = "";
  for (;;) {
    const c = await w.claim();
    if (!c) break;
    if (c.task.kind === "build") {
      const m = await w.upload(c.task.id, c.leaseToken, "model", "sim", Buffer.from("x"));
      await w.complete(c.task.id, c.leaseToken, { state: "PASSED", durationMs: 1, modelArtifactId: m.json.id });
    } else {
      const l = await w.upload(c.task.id, c.leaseToken, "log", "t.log", gzipSync("secret log"), { encoding: "gzip" });
      logArtifact = l.json.id;
      failedTask = c.task.id;
      await w.complete(c.task.id, c.leaseToken, { state: "FAILED", durationMs: 1 });
    }
  }
  const secret = await b.c.put(`/api/v1/projects/${b.project.id}/secrets/API_TOKEN`, { value: "s3cr3t-value-123" });
  expect(secret.status).toBe(200);
  return { ...b, job, logArtifact, failedTask };
}

describe("multi-tenancy", () => {
  it("user A cannot read, modify or even detect any of organization B's resources", async () => {
    const v = await victim();
    const a = await orgWithProject(s.base, "attacker");
    const nonexistent = "00000000-0000-4000-8000-000000000000";
    const probes: [string, string, unknown?][] = [
      ["GET", `/api/v1/projects/${v.project.id}`],
      ["PATCH", `/api/v1/projects/${v.project.id}`, { name: "pwned" }],
      ["DELETE", `/api/v1/projects/${v.project.id}`],
      ["GET", `/api/v1/projects/${v.project.id}/jobs`],
      ["POST", `/api/v1/projects/${v.project.id}/jobs`, { regression: "smoke" }],
      ["POST", `/api/v1/jobs`, { projectId: v.project.id }],
      ["GET", `/api/v1/jobs/${v.job.id}`],
      ["GET", `/api/v1/jobs/${v.job.id}/config`],
      ["POST", `/api/v1/jobs/${v.job.id}/cancel`],
      ["POST", `/api/v1/jobs/${v.job.id}/rerun`, {}],
      ["GET", `/api/v1/jobs/${v.job.id}/tasks`],
      ["GET", `/api/v1/jobs/${v.job.id}/coverage`],
      ["GET", `/api/v1/jobs/${v.job.id}/compare?with=${v.job.id}`],
      ["GET", `/api/v1/tasks/${v.failedTask}`],
      ["GET", `/api/v1/tasks/${v.failedTask}/log`],
      ["POST", `/api/v1/tasks/${v.failedTask}/analyze`],
      ["GET", `/api/v1/tasks/${v.failedTask}/reproduce`],
      ["GET", `/api/v1/artifacts/${v.logArtifact}`],
      ["GET", `/api/v1/artifacts/${v.logArtifact}/download`],
      ["DELETE", `/api/v1/artifacts/${v.logArtifact}`],
      ["GET", `/api/v1/projects/${v.project.id}/artifacts`],
      ["GET", `/api/v1/projects/${v.project.id}/secrets`],
      ["PUT", `/api/v1/projects/${v.project.id}/secrets/X`, { value: "y" }],
      ["GET", `/api/v1/projects/${v.project.id}/coverage`],
      ["GET", `/api/v1/orgs/${v.slug}`],
      ["GET", `/api/v1/orgs/${v.slug}/members`],
      ["GET", `/api/v1/orgs/${v.slug}/audit`],
      ["GET", `/api/v1/orgs/${v.slug}/usage`],
      ["GET", `/api/v1/orgs/${v.slug}/dashboard`],
      ["GET", `/api/v1/events?project=${v.project.id}`],
    ];
    for (const [method, path, body] of probes) {
      const r = await a.c.req(method, path, body);
      expect([404, 400], `${method} ${path} → ${r.status}`).toContain(r.status);
      // indistinguishable from a resource that does not exist
      const ghost = await a.c.req(method, path.replace(v.project.id, nonexistent).replace(v.job.id, nonexistent).replace(v.failedTask, nonexistent).replace(v.logArtifact, nonexistent).replace(v.slug, "no-such-org"), body);
      expect(ghost.status, `${method} ${path} (nonexistent)`).toBe(r.status);
      if (r.status === 404) expect(r.json.error.code).toBe(ghost.json.error.code);
    }
    // nothing changed
    const p = await v.c.get(`/api/v1/projects/${v.project.id}`);
    expect(p.json.project.name).toBe("Demo");
    expect((await v.c.get(`/api/v1/jobs/${v.job.id}`)).json.job.state).toBe("FAILED");
  });

  it("an organization API key never reaches another organization", async () => {
    const v = await victim();
    const a = await orgWithProject(s.base, "keyholder");
    const k = await a.c.post(`/api/v1/orgs/${a.slug}/api-keys`, { name: "ci", role: "engineer", scopes: ["read", "write"] });
    const key = new Client(s.base);
    key.token = k.json.token;
    expect((await key.get(`/api/v1/projects/${a.project.id}`)).status).toBe(200);
    expect((await key.get(`/api/v1/projects/${v.project.id}`)).status).toBe(404);
    expect((await key.get(`/api/v1/orgs`)).json.organizations.map((o: any) => o.id)).toEqual([a.org.id]);
  });

  it("workers can only touch artifacts of the task they hold a lease for", async () => {
    const v = await victim();
    const a = await orgWithProject(s.base, "wkr");
    await uploadSnapshot(a.c, a.project.id, snapshotOf(files));
    await a.c.post(`/api/v1/projects/${a.project.id}/jobs`, { regression: "smoke" });
    const w = await new FakeWorker(s.base).register();
    const c = await w.claim();
    const srcOfVictim = (await s.db.query("SELECT source->>'artifactId' AS id FROM jobs WHERE id = $1", [v.job.id])).rows[0].id;
    expect((await w.call("GET", `/tasks/${c.task.id}/artifacts/${srcOfVictim}`, { lease: c.leaseToken })).status).toBe(404);
    expect((await w.call("GET", `/tasks/${c.task.id}/artifacts/${srcOfVictim}`, { lease: "00000000-0000-4000-8000-000000000000" })).status).toBe(409);
  });
});

describe("role-based access control", () => {
  it("enforces viewer < engineer < admin < owner on the server", async () => {
    const o = await orgWithProject(s.base);
    await uploadSnapshot(o.c, o.project.id, snapshotOf(files));
    const viewer = await newUser(s.base, "viewer");
    const engineer = await newUser(s.base, "engineer");
    const admin = await newUser(s.base, "admin");
    for (const [u, role] of [[viewer, "viewer"], [engineer, "engineer"], [admin, "admin"]] as const) expect((await o.c.post(`/api/v1/orgs/${o.slug}/members`, { email: u.email, role })).status).toBe(201);
    const pid = o.project.id;
    // viewers read but cannot run or change anything
    expect((await viewer.c.get(`/api/v1/projects/${pid}`)).status).toBe(200);
    expect((await viewer.c.post(`/api/v1/projects/${pid}/jobs`, { regression: "smoke" })).status).toBe(403);
    // engineers run jobs but cannot change settings, secrets or members
    const job = await engineer.c.post(`/api/v1/projects/${pid}/jobs`, { regression: "smoke" });
    expect(job.status).toBe(201);
    expect((await viewer.c.post(`/api/v1/jobs/${job.json.job.id}/cancel`)).status).toBe(403);
    expect((await engineer.c.patch(`/api/v1/projects/${pid}`, { maxConcurrency: 99 })).status).toBe(403);
    expect((await engineer.c.put(`/api/v1/projects/${pid}/secrets/K`, { value: "v" })).status).toBe(403);
    expect((await engineer.c.post(`/api/v1/orgs/${o.slug}/members`, { email: viewer.email, role: "admin" })).status).toBe(403);
    // admins manage, but cannot grant owner or touch owners/admins
    expect((await admin.c.patch(`/api/v1/projects/${pid}`, { maxConcurrency: 8 })).status).toBe(200);
    expect((await admin.c.patch(`/api/v1/orgs/${o.slug}/members/${viewer.id}`, { role: "owner" })).status).toBe(403);
    expect((await admin.c.patch(`/api/v1/orgs/${o.slug}/members/${o.id}`, { role: "viewer" })).status).toBe(403);
    expect((await admin.c.patch(`/api/v1/orgs/${o.slug}/members/${viewer.id}`, { role: "engineer" })).status).toBe(200);
    // the last owner cannot be demoted
    expect((await o.c.patch(`/api/v1/orgs/${o.slug}/members/${o.id}`, { role: "admin" })).json.error.code).toBe("LAST_OWNER");
    // removed members lose access immediately
    expect((await o.c.del(`/api/v1/orgs/${o.slug}/members/${engineer.id}`)).status).toBe(200);
    expect((await engineer.c.get(`/api/v1/projects/${pid}`)).status).toBe(404);
  });

  it("token scopes cap the owner's role; tokens cannot mint tokens", async () => {
    const o = await orgWithProject(s.base);
    const pat = await o.c.post("/api/v1/me/tokens", { name: "ro", scopes: ["read"] });
    expect(pat.status).toBe(201);
    const ro = new Client(s.base);
    ro.token = pat.json.token;
    expect((await ro.get(`/api/v1/projects/${o.project.id}`)).status).toBe(200);
    expect((await ro.patch(`/api/v1/projects/${o.project.id}`, { name: "x" })).status).toBe(403);
    expect((await ro.post("/api/v1/me/tokens", { name: "escalate", scopes: ["admin"] })).status).toBe(403);
    expect((await o.c.del(`/api/v1/me/tokens/${pat.json.id}`)).status).toBe(200);
    expect((await ro.get(`/api/v1/projects/${o.project.id}`)).status).toBe(401);
    // an org key cannot exceed its creator's role
    const viewer = await newUser(s.base, "v2");
    await o.c.post(`/api/v1/orgs/${o.slug}/members`, { email: viewer.email, role: "viewer" });
    expect((await viewer.c.post(`/api/v1/orgs/${o.slug}/api-keys`, { name: "x", role: "viewer", scopes: ["read"] })).status).toBe(403);
  });
});

describe("authentication", () => {
  it("rejects forged, expired and revoked credentials", async () => {
    const anon = new Client(s.base);
    expect((await anon.get("/api/v1/me")).status).toBe(401);
    anon.cookie = "vc_session=vc_sess_forged";
    expect((await anon.get("/api/v1/me")).status).toBe(401);
    anon.cookie = "";
    anon.token = "vc_pat_" + "A".repeat(43);
    expect((await anon.get("/api/v1/me")).status).toBe(401);
    const u = await newUser(s.base);
    await s.db.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [u.id]);
    expect((await u.c.get("/api/v1/me")).status).toBe(401);
  });

  it("stores only password and token hashes; login errors do not reveal accounts", async () => {
    const u = await newUser(s.base);
    const row = (await s.db.query("SELECT password_hash FROM users WHERE id = $1", [u.id])).rows[0];
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(row.password_hash).not.toContain("correct horse");
    const c = new Client(s.base);
    const wrongPw = await c.post("/api/v1/auth/login", { email: u.email, password: "wrong password 1" });
    const noUser = await c.post("/api/v1/auth/login", { email: "nobody@example.com", password: "wrong password 1" });
    expect(wrongPw.status).toBe(401);
    expect(noUser.json.error).toMatchObject({ code: wrongPw.json.error.code, message: wrongPw.json.error.message });
    const sess = (await s.db.query("SELECT token_hash FROM sessions WHERE user_id = $1 LIMIT 1", [u.id])).rows[0];
    expect(Buffer.isBuffer(sess.token_hash)).toBe(true);
  });

  it("rate-limits login attempts per account", async () => {
    const t = await createTestDatabase();
    const strict = await startServer(t.url, { limits: { authRatePerMinute: 5 } as any });
    try {
      const u = await newUser(strict.base);
      const c = new Client(strict.base);
      const codes = [];
      for (let i = 0; i < 8; i++) codes.push((await c.post("/api/v1/auth/login", { email: u.email, password: "wrong password 1" })).status);
      expect(codes).toContain(429);
    } finally {
      await strict.app.close();
      await t.drop();
    }
  });

  it("verifies email addresses with single-use tokens", async () => {
    const u = await newUser(s.base);
    const mail = s.app.ctx.mailer.outbox.find((m) => m.to === u.email)!;
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    expect((await u.c.post("/api/v1/auth/verify-email", { token })).status).toBe(200);
    expect((await u.c.post("/api/v1/auth/verify-email", { token })).status).toBe(400);
    expect((await u.c.get("/api/v1/me")).json.user.emailVerified).toBe(true);
  });
});

describe("web security", () => {
  it("refuses cookie-authenticated writes from foreign origins (CSRF)", async () => {
    const o = await orgWithProject(s.base);
    const r = await o.c.req("PATCH", `/api/v1/projects/${o.project.id}`, { name: "x" }, { Origin: "https://evil.example" });
    expect(r.status).toBe(403);
    const none = await fetch(`${s.base}/api/v1/projects/${o.project.id}`, { method: "PATCH", headers: { Cookie: o.c.cookie, "Content-Type": "application/json" }, body: "{}" });
    expect(none.status).toBe(403);
  });

  it("returns consistent error objects without stack traces", async () => {
    const r = await new Client(s.base).get("/api/v1/no-such-route");
    expect(r.json).toMatchObject({ error: { code: "ROUTE_NOT_FOUND" } });
    const bad = await (await newUser(s.base)).c.post("/api/v1/orgs", { name: "", slug: "'; DROP TABLE users;--" });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.json)).not.toMatch(/at .*\.ts:\d+|node_modules/);
    expect(bad.json.error.requestId).toBeTruthy();
    expect((await s.db.query("SELECT count(*)::int AS n FROM users")).rows[0].n).toBeGreaterThan(0);
  });

  it("treats injection payloads in parameters as data", async () => {
    const o = await orgWithProject(s.base);
    for (const q of ["' OR 1=1 --", "%' UNION SELECT password_hash FROM users --", "${7*7}"]) {
      const r = await o.c.get(`/api/v1/orgs/${o.slug}/audit?action=${encodeURIComponent(q)}`);
      expect(r.status).toBe(200);
      expect(r.json.events).toEqual([]);
    }
    expect((await o.c.get(`/api/v1/jobs/1%20OR%201=1`)).status).toBe(400);
  });

  it("never returns secret values, and protects /metrics", async () => {
    const v = await victim();
    const list = await v.c.get(`/api/v1/projects/${v.project.id}/secrets`);
    expect(JSON.stringify(list.json)).not.toContain("s3cr3t-value-123");
    const raw = (await s.db.query("SELECT ciphertext FROM project_secrets WHERE project_id = $1", [v.project.id])).rows[0].ciphertext as Buffer;
    expect(raw.toString("utf8")).not.toContain("s3cr3t");
    // /metrics: allowed from loopback without token; with METRICS_TOKEN set, the token is required
    process.env.METRICS_TOKEN = "metrics-token-123";
    try {
      expect((await fetch(`${s.base}/metrics`)).status).toBe(404);
      expect((await fetch(`${s.base}/metrics`, { headers: { Authorization: "Bearer metrics-token-123" } })).status).toBe(200);
    } finally {
      delete process.env.METRICS_TOKEN;
    }
  });

  it("rejects malicious source archives: traversal, absolute paths, symlinks, bombs", async () => {
    const o = await orgWithProject(s.base);
    const { tarFiles } = await import("@verifycloud/shared");
    const tarWith = (name: string, type = "0", link = "") => {
      const t = tarFiles([{ path: "placeholder.txt", content: Buffer.from("x") }]);
      const h = t.subarray(0, 512);
      h.fill(0, 0, 100);
      Buffer.from(name).copy(h, 0);
      h.write(type, 156);
      Buffer.from(link).copy(h, 157);
      h.write("        ", 148);
      let sum = 0;
      for (const b of h) sum += b;
      h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
      return gzipSync(t);
    };
    for (const [name, type, link, expected] of [
      ["../../etc/cron.d/x", "0", "", /unsafe path/],
      ["/etc/passwd", "0", "", /unsafe path/],
      ["link", "2", "/etc/shadow", /SymbolicLink/],
      ["hard", "1", "verifycloud.yaml", /Link/],
    ] as const) {
      const r = await o.c.req("POST", `/api/v1/projects/${o.project.id}/snapshots`, tarWith(name, type, link), { "Content-Type": "application/gzip" });
      expect(r.status, name).toBe(400);
      expect(r.json.error.message).toMatch(expected);
    }
    // decompression bomb: 600 MB of zeros compresses to ~600 KB
    const bomb = gzipSync(Buffer.alloc(600 * 1024 * 1024));
    const b = await o.c.req("POST", `/api/v1/projects/${o.project.id}/snapshots`, bomb, { "Content-Type": "application/gzip" });
    expect(b.status).toBe(400);
  });
});

describe("audit log", () => {
  it("records security-relevant actions with actor, target and request id", async () => {
    const o = await orgWithProject(s.base);
    const viewer = await newUser(s.base, "audited");
    await o.c.post(`/api/v1/orgs/${o.slug}/members`, { email: viewer.email, role: "viewer" });
    await o.c.post(`/api/v1/orgs/${o.slug}/api-keys`, { name: "ci", role: "viewer", scopes: ["read"] });
    const r = await o.c.get(`/api/v1/orgs/${o.slug}/audit`);
    const actions = r.json.events.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["org.create", "project.create", "member.add", "api_key.create"]));
    expect(r.json.events[0].request_id).toBeTruthy();
    expect((await viewer.c.get(`/api/v1/orgs/${o.slug}/audit`)).status).toBe(403);
  });
});

describe("public demo mode", () => {
  it("anonymous demo users can run the seeded project but cannot upload code, create projects, submit or generate patches", async () => {
    const { seedDemo } = await import("../src/seed.js");
    const { DEMO_DIR } = await import("./helpers.js");
    const db2 = await createTestDatabase();
    const d = await startServer(db2.url, { publicDemo: true });
    try {
      const seeded = await seedDemo(d.app.ctx, { examplesDir: DEMO_DIR });
      const c = new Client(d.base);
      const r = await c.post("/api/v1/auth/demo");
      expect(r.status).toBe(200);
      const me = (await c.get("/api/v1/me")).json;
      expect(me.organizations).toEqual([expect.objectContaining({ slug: "demo", role: "engineer" })]);
      // running the pre-approved project is allowed
      const job = await c.post(`/api/v1/projects/${seeded.projectId}/jobs`, { regression: "smoke" });
      expect(job.status).toBe(201);
      // code-changing actions are refused
      const up = await c.req("POST", `/api/v1/projects/${seeded.projectId}/snapshots`, snapshotOf({ "verifycloud.yaml": minimalConfig(), "rtl/a.sv": "module a; endmodule", "tb/tb.sv": "module tb; initial $system(\"id\"); endmodule" }), { "Content-Type": "application/gzip" });
      expect(up.status).toBe(403);
      expect(up.json.error.code).toBe("DEMO_MODE_RESTRICTED");
      expect((await c.post("/api/v1/orgs/demo/projects", { name: "x", slug: "x" })).status).toBe(403);
      const patch = await c.post(`/api/v1/jobs/${job.json.job.id}/patches`, { diff: "--- a/rtl/axil_regs.sv\n+++ b/rtl/axil_regs.sv\n@@ -1 +1 @@\n-x\n+y\n" });
      expect(patch.status).toBe(403);
      expect((await c.post(`/api/v1/projects/${seeded.projectId}/jobs`, { regression: "smoke", ref: "main" })).status).toBe(403);
      // demo sessions are rate limited per IP
      for (let i = 0; i < 5; i++) await new Client(d.base).post("/api/v1/auth/demo");
      expect((await new Client(d.base).post("/api/v1/auth/demo")).status).toBe(429);
    } finally {
      await d.app.close();
      await db2.drop();
    }
  });
});
