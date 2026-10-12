// API latency under concurrent load (closed loop: each virtual client sends
// the next request when the previous one returns), against a server with a
// realistic amount of data (one project with 30 finished jobs of 13 tasks).
//   npx tsx bench/api.ts > docs/benchmarks/api.json
import { createTestDatabase, FakeWorker, orgWithProject, snapshotOf, startServer, uploadSnapshot } from "../packages/server/test/helpers.js";
import { environment, stats } from "./env.js";

const DURATION_MS = Number(process.env.BENCH_SECONDS ?? 10) * 1000;
const cfg = `version: 1
project: { name: bench }
rtl: { sources: ["rtl/*.sv"] }
testbench: { sources: ["tb/*.sv"], top: tb }
simulator: { engine: verilator }
tests:
  t: { seeds: [1,2,3,4,5,6,7,8,9,10,11,12] }
regressions:
  r: { tests: [t] }
`;

const db = await createTestDatabase();
const s = await startServer(db.url, { logLevel: "error", limits: { apiRatePerMinute: 10_000_000, jobCreatePerMinute: 10_000_000 } as any });
const o = await orgWithProject(s.base, "bench");
await uploadSnapshot(o.c, o.project.id, snapshotOf({ "verifycloud.yaml": cfg, "rtl/a.sv": "module a; endmodule\n", "tb/tb.sv": "module tb; endmodule\n" }));
const w = await new FakeWorker(s.base).register();
let lastJob = "";
for (let i = 0; i < 30; i++) {
  lastJob = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "r" })).json.job.id;
  await w.drain((t) => (t.seed === 3 && i % 3 === 0 ? "FAILED" : "PASSED"));
}
const token = (await o.c.post("/api/v1/me/tokens", { name: "bench", scopes: ["read", "write"] })).json.token;
const H = { Authorization: `Bearer ${token}` };

const scenarios: Record<string, () => Promise<Response>> = {
  "GET /health": () => fetch(`${s.base}/health`),
  "GET /api/v1/projects/:id/jobs": () => fetch(`${s.base}/api/v1/projects/${o.project.id}/jobs?limit=25`, { headers: H }),
  "GET /api/v1/jobs/:id": () => fetch(`${s.base}/api/v1/jobs/${lastJob}`, { headers: H }),
  "GET /api/v1/jobs/:id/tasks": () => fetch(`${s.base}/api/v1/jobs/${lastJob}/tasks`, { headers: H }),
  "GET /api/v1/orgs/:org/dashboard": () => fetch(`${s.base}/api/v1/orgs/${o.slug}/dashboard`, { headers: H }),
  "POST /api/v1/projects/:id/jobs (create, 13 tasks)": () => fetch(`${s.base}/api/v1/projects/${o.project.id}/jobs`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ regression: "r" }) }),
};

async function load(name: string, fn: () => Promise<Response>, concurrency: number) {
  const lat: number[] = [];
  let errors = 0;
  const statuses: Record<number, number> = {};
  const end = Date.now() + DURATION_MS;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (Date.now() < end) {
        const t = performance.now();
        try {
          const r = await fn();
          await r.arrayBuffer();
          statuses[r.status] = (statuses[r.status] ?? 0) + 1;
          if (r.status >= 400) errors++;
        } catch {
          errors++;
        }
        lat.push(performance.now() - t);
      }
    }),
  );
  return { endpoint: name, concurrency, requests: lat.length, rps: +(lat.length / (DURATION_MS / 1000)).toFixed(1), errors, statuses, latencyMs: stats(lat) };
}

const results = [];
for (const [name, fn] of Object.entries(scenarios))
  for (const c of [1, 10, 50]) {
    if (name.startsWith("POST") && c === 50) continue; // keeps the job table bounded; creation is measured at 1 and 10
    const r = await load(name, fn, c);
    console.error(`${name} c=${c}: ${r.rps} rps p50 ${r.latencyMs.p50} p95 ${r.latencyMs.p95} p99 ${r.latencyMs.p99} errors ${r.errors}`);
    results.push(r);
    if (name.startsWith("POST")) await s.db.query("UPDATE tasks SET state = 'CANCELLED' WHERE state IN ('QUEUED','BLOCKED'); UPDATE jobs SET state = 'CANCELLED' WHERE state IN ('QUEUED','RUNNING')");
  }
console.log(JSON.stringify({ benchmark: "API latency (closed-loop clients, same host)", environment: environment(), durationSecondsPerScenario: DURATION_MS / 1000, results }, null, 2));
await s.app.close();
await db.drop();
process.exit(0);
