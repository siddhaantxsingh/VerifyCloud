// Test helpers: a fresh database per test file, a real API server on a
// random port, S3 via the local S3-compatible endpoint (moto in this
// environment, MinIO in docker-compose), HTTP clients, and a scriptable fake
// worker that speaks the internal API (for scheduler/lease tests).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { tarFiles } from "@verifycloud/shared";
import pg from "pg";

import { createApp, type App } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { snapshotOfDir } from "../src/seed.js";

export const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
export const S3 = process.env.TEST_S3_ENDPOINT ?? "http://127.0.0.1:9000";
// Credentials for the test S3 endpoint. Read from the environment so the suite
// runs against real MinIO (which rejects secrets shorter than 8 characters) as
// well as against permissive emulators. Before 2026-10-14 these were hard-coded
// to "test"/"test", so every S3-backed test failed against MinIO and in CI.
export const S3_KEY = process.env.TEST_S3_ACCESS_KEY_ID ?? process.env.S3_ACCESS_KEY_ID ?? "test";
export const S3_SECRET = process.env.TEST_S3_SECRET_ACCESS_KEY ?? process.env.S3_SECRET_ACCESS_KEY ?? "test";
export const ROOT = join(import.meta.dirname, "..", "..", "..");
export const DEMO_DIR = join(ROOT, "examples", "axi4lite-demo");
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function createTestDatabase() {
  const name = `vc_test_${randomBytes(4).toString("hex")}`;
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  return {
    url: u.toString(),
    async drop() {
      const c2 = new pg.Client({ connectionString: ADMIN_URL });
      await c2.connect();
      await c2.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c2.end();
    },
  };
}

export interface TestServer {
  app: App;
  base: string;
  port: number;
  db: App["ctx"]["db"];
}

export async function startServer(dbUrl: string, over: Partial<ServerConfig> = {}, opts: { background?: boolean } = {}): Promise<TestServer> {
  process.env.S3_ACCESS_KEY_ID ??= S3_KEY;
  process.env.S3_SECRET_ACCESS_KEY ??= S3_SECRET;
  const app = await createApp(
    {
      databaseUrl: dbUrl,
      port: 0,
      host: "127.0.0.1",
      logLevel: "error",
      s3: { endpoint: S3, region: "us-east-1", bucket: `vc-${randomBytes(4).toString("hex")}`, accessKeyId: S3_KEY, secretAccessKey: S3_SECRET, forcePathStyle: true },
      ...over,
      limits: { maxUploadBytes: 50 * 1024 * 1024, maxArtifactBytes: 256 * 1024 * 1024, uploadMemoryBudgetBytes: 1024 * 1024 * 1024, leaseSeconds: 30, reaperIntervalMs: 500, apiRatePerMinute: 100_000, authRatePerMinute: 1000, jobCreatePerMinute: 120, ...(over.limits ?? {}) },
    },
    { background: opts.background ?? true },
  );
  const port = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  app.ctx.cfg.publicUrl = base;
  return { app, base, port, db: app.ctx.db };
}

export class Client {
  cookie = "";
  token = "";
  constructor(public base: string) {}
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { Origin: this.base, ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    let b: BodyInit | undefined;
    if (Buffer.isBuffer(body)) {
      h["Content-Type"] ??= "application/gzip";
      b = new Uint8Array(body);
    } else if (body !== undefined) {
      h["Content-Type"] = "application/json";
      b = JSON.stringify(body);
    }
    const res = await fetch(this.base + path, { method, headers: h, body: b, redirect: "manual" });
    const sc = res.headers.get("set-cookie");
    if (sc?.startsWith("vc_session=")) this.cookie = sc.split(";")[0]!;
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  }
  get = (p: string) => this.req("GET", p);
  post = (p: string, b?: unknown, h?: Record<string, string>) => this.req("POST", p, b ?? {}, h);
  patch = (p: string, b: unknown) => this.req("PATCH", p, b);
  put = (p: string, b: unknown) => this.req("PUT", p, b);
  del = (p: string) => this.req("DELETE", p);
}

let n = 0;
export async function newUser(base: string, name = "user") {
  const c = new Client(base);
  const email = `${name}_${randomBytes(4).toString("hex")}_${n++}@example.com`;
  const r = await c.post("/api/v1/auth/register", { email, password: "correct horse battery", name });
  if (r.status !== 201) throw new Error(`register failed ${JSON.stringify(r.json)}`);
  return { c, email, id: r.json.user.id as string };
}

/** A user with an organization and a project. */
export async function orgWithProject(base: string, name = "owner") {
  const u = await newUser(base, name);
  const slug = `o-${randomBytes(4).toString("hex")}`;
  const o = await u.c.post("/api/v1/orgs", { name: `Org ${slug}`, slug });
  if (o.status !== 201) throw new Error(JSON.stringify(o.json));
  const p = await u.c.post(`/api/v1/orgs/${slug}/projects`, { name: "Demo", slug: "demo" });
  if (p.status !== 201) throw new Error(JSON.stringify(p.json));
  return { ...u, org: o.json.organization, slug, project: p.json.project };
}

export const demoSnapshot = () => snapshotOfDir(DEMO_DIR);

/** A snapshot from in-memory files (path → content). */
export function snapshotOf(files: Record<string, string>): Buffer {
  return gzipSync(tarFiles(Object.entries(files).map(([path, content]) => ({ path, content: Buffer.from(content) }))));
}

export const minimalConfig = (extra = "") => `version: 1
project: { name: t }
rtl: { sources: ["rtl/*.sv"] }
testbench: { sources: ["tb/*.sv"], top: tb }
simulator: { engine: verilator, timing: true }
tests:
  t1: {}
  t2: { seeds: [1, 2, 3] }
regressions:
  smoke: { tests: [t1, t2] }
${extra}`;

export async function uploadSnapshot(c: Client, projectId: string, gz: Buffer) {
  const r = await c.req("POST", `/api/v1/projects/${projectId}/snapshots`, gz, { "Content-Type": "application/gzip" });
  if (r.status !== 201) throw new Error(`snapshot upload failed ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 60_000, what = "condition"): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// -------------------------------------------------------------- fake worker
export class FakeWorker {
  token = "";
  id = "";
  constructor(public base: string, public regToken = "dev-worker-token") {}
  async register(name = "fake") {
    const r = await fetch(this.base + "/internal/v1/workers/register", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.regToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, version: "test", sandbox: "docker", cpus: 64, memoryMb: 65536, toolchain: { fake: true } }),
    });
    const j = (await r.json()) as any;
    this.token = j.token;
    this.id = j.workerId;
    return this;
  }
  async call(method: string, path: string, opts: { lease?: string; body?: unknown; raw?: Buffer; query?: Record<string, string> } = {}) {
    const u = new URL(this.base + "/internal/v1" + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) u.searchParams.set(k, v);
    const h: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (opts.lease) h["X-Lease-Token"] = opts.lease;
    let body: BodyInit | undefined;
    if (opts.raw) {
      h["Content-Type"] = "application/octet-stream";
      body = new Uint8Array(opts.raw);
    } else if (opts.body !== undefined) {
      h["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(u, { method, headers: h, body });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
  async claim(cpu = 64, memoryMb = 65536) {
    const r = await this.call("POST", "/tasks/claim", { body: { cpu, memoryMb } });
    return r.json?.task ? r.json : null;
  }
  heartbeat(taskId: string, lease: string) {
    return this.call("POST", `/tasks/${taskId}/heartbeat`, { lease });
  }
  upload(taskId: string, lease: string, kind: string, name: string, body: Buffer, opts: { encoding?: string; meta?: object; contentType?: string } = {}) {
    const query: Record<string, string> = { kind, name, contentType: opts.contentType ?? "application/octet-stream" };
    if (opts.encoding) query.encoding = opts.encoding;
    if (opts.meta) query.meta = JSON.stringify(opts.meta);
    return this.call("POST", `/tasks/${taskId}/artifacts`, { lease, raw: body, query });
  }
  complete(taskId: string, lease: string, report: Record<string, unknown>) {
    return this.call("POST", `/tasks/${taskId}/complete`, { lease, body: { report } });
  }
  /** Claim and complete everything currently claimable; build PASSED with a dummy model, tests per `decide`. */
  async drain(decide: (t: any) => string = () => "PASSED", max = 1000) {
    let done = 0;
    for (; done < max; done++) {
      const c = await this.claim();
      if (!c) break;
      if (c.task.kind === "build") {
        const m = await this.upload(c.task.id, c.leaseToken, "model", "sim.gz", gzipSync(Buffer.from("model")), { encoding: "gzip" });
        await this.complete(c.task.id, c.leaseToken, { state: "PASSED", durationMs: 10, modelArtifactId: m.json.id, result: { summary: "built" } });
      } else await this.complete(c.task.id, c.leaseToken, { state: decide(c.task), durationMs: 5, result: { summary: "fake" } });
    }
    return done;
  }
}

export const readExample = (p: string) => readFileSync(join(DEMO_DIR, p), "utf8");
