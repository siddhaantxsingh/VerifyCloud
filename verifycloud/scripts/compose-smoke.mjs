#!/usr/bin/env node
// Smoke test for a running Compose stack (docker compose up), through the
// public API only. Used in the 2026-10-14 audit with the official images.
//
//   BASE=http://localhost:8080 EMAIL=admin@demo.local PASSWORD=… node scripts/compose-smoke.mjs run
//   … node scripts/compose-smoke.mjs check     # after restarting services
//
// "run": logs in as the seeded demo admin, starts the demo's `full` regression,
// waits for it, and checks the expected outcome (FAILED, only `random` and
// `rw_overlap` fail), merged coverage and the rule-based analysis. Prints the
// job id and writes the SHA-256 of every artifact of the job to $STATE.
// "check": logs in again, downloads every artifact of that job and compares
// with $STATE (persistence across restarts of PostgreSQL, MinIO and the API).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const BASE = (process.env.BASE ?? "http://localhost:8080").replace(/\/$/, "");
const EMAIL = process.env.EMAIL ?? "admin@demo.local";
const PASSWORD = process.env.PASSWORD;
if (!PASSWORD) throw new Error("set PASSWORD (DEMO_ADMIN_PASSWORD from .env)");
let cookie = "";

async function api(method, path, body) {
  const headers = { Origin: BASE };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + "/api/v1" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get("set-cookie");
  if (sc?.startsWith("vc_session=")) cookie = sc.split(";")[0];
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return json;
}
const STATE = process.env.STATE ?? "compose-smoke-state.json";

async function artifactHashes(jobId) {
  const out = {};
  for (const t of (await api("GET", `/jobs/${jobId}/tasks`)).tasks) {
    for (const a of (await api("GET", `/tasks/${t.id}`)).artifacts ?? []) {
      const res = await fetch(`${BASE}/api/v1/artifacts/${a.id}/download`, { headers: { Cookie: cookie } });
      const buf = Buffer.from(await res.arrayBuffer());
      out[a.id] = res.status === 200 ? createHash("sha256").update(buf).digest("hex") : `HTTP ${res.status}`;
    }
  }
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function login() {
  await api("POST", "/auth/login", { email: EMAIL, password: PASSWORD });
  const p = (await api("GET", "/orgs/demo/projects")).projects.find((x) => x.slug === "axi4lite-demo");
  if (!p) throw new Error("demo project not found");
  return p;
}

async function waitJob(id, ms = 1_800_000) {
  const t0 = Date.now();
  for (;;) {
    const j = (await api("GET", `/jobs/${id}`)).job;
    if (["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "RESOURCE_EXCEEDED", "ERROR"].includes(j.state)) return j;
    if (Date.now() - t0 > ms) throw new Error(`job ${id} still ${j.state}`);
    await sleep(3000);
  }
}

async function run() {
  const p = await login();
  log("logged in; demo project", p.id);
  const t0 = Date.now();
  const job = (await api("POST", `/projects/${p.id}/jobs`, { regression: "full" })).job;
  log("started job", job.id);
  const done = await waitJob(job.id);
  const tasks = (await api("GET", `/jobs/${job.id}/tasks`)).tasks;
  const tests = tasks.filter((t) => t.kind === "test");
  const failed = tests.filter((t) => t.state === "FAILED").map((t) => t.test_name);
  log(`job ${done.state} in ${((Date.now() - t0) / 1000).toFixed(0)} s; ${tests.length} tests, failed: ${[...new Set(failed)].join(", ")}`);
  const ok = done.state === "FAILED" && tests.length === 13 && failed.length > 0 && failed.every((n) => ["random", "rw_overlap"].includes(n));
  const cov = await api("GET", `/jobs/${job.id}/coverage`);
  log("coverage available:", cov.available, JSON.stringify(cov.summary ?? {}));
  const rnd = tests.find((t) => t.test_name === "random" && t.state === "FAILED");
  const an = (await api("POST", `/tasks/${rnd.id}/analyze`)).analysis;
  const loc = (an.result?.locations ?? []).map((l) => `${l.file}:${l.line}${l.verified ? " (verified)" : ""}`);
  log("analysis:", an.status, an.result?.confidence ?? "", loc.join(", "));
  const hashes = await artifactHashes(job.id);
  writeFileSync(STATE, JSON.stringify({ jobId: job.id, hashes }, null, 1));
  log(`recorded ${Object.keys(hashes).length} artifact hashes in ${STATE}`);
  console.log(`JOB_ID=${job.id}`);
  if (!ok || !cov.available || an.status !== "succeeded") {
    console.log("SMOKE_RESULT=FAIL");
    process.exit(1);
  }
  console.log("SMOKE_RESULT=PASS");
}

async function check() {
  await login();
  const want = JSON.parse(readFileSync(STATE, "utf8"));
  const got = await artifactHashes(want.jobId);
  const ids = Object.keys(want.hashes);
  const bad = ids.filter((id) => got[id] !== want.hashes[id] || want.hashes[id].startsWith("HTTP"));
  for (const id of bad) log("MISMATCH", id, want.hashes[id], got[id]);
  log(`checked ${ids.length} artifacts of job ${want.jobId}; ${bad.length} bad`);
  const ok = ids.length > 0 && bad.length === 0;
  console.log(ok ? "PERSIST_RESULT=PASS" : "PERSIST_RESULT=FAIL");
  process.exit(ok ? 0 : 1);
}

const [cmd] = process.argv.slice(2);
if (cmd === "run") await run();
else if (cmd === "check") await check();
else throw new Error("usage: compose-smoke.mjs run | check");
