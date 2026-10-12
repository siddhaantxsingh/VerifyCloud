// Real simulation throughput: the demo design (with the reference fix, so all
// runs pass) as a regression of RUNS randomized test runs, executed by one
// worker with 1/5/10/25 concurrent sandbox slots. Every run is a real
// Verilator simulation in its own Docker container (network none, read-only
// root, caps dropped, limits). The compiled model comes from the build cache
// after the first job, so the numbers measure simulation + sandbox overhead.
//   npx tsx bench/sandbox.ts   (writes docs/benchmarks/sandbox.json)
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

import { applyFilePatch, parseUnifiedDiff } from "@verifycloud/shared";

import { createTestDatabase, DEMO_DIR, orgWithProject, snapshotOf, startServer, uploadSnapshot } from "../packages/server/test/helpers.js";
import { startWorker } from "../packages/worker/src/main.js";
import { environment, stats } from "./env.js";

const RUNS = Number(process.env.BENCH_RUNS ?? 50);
const SLOTS = (process.env.BENCH_SLOTS ?? "1,5,10,25").split(",").map(Number);

// demo sources with the reference fix applied
const files: Record<string, string> = {};
const walk = (d: string) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else files[relative(DEMO_DIR, p)] = readFileSync(p, "utf8");
  }
};
walk(DEMO_DIR);
for (const fp of parseUnifiedDiff(files["fix-rdata-stable.patch"]!)) files[fp.newPath!] = applyFilePatch(files[fp.oldPath!] ?? null, fp)!;
files["verifycloud.yaml"] = `version: 1
project: { name: bench }
rtl: { sources: ["rtl/**/*.sv"] }
testbench: { sources: ["tb/axil_checker.sv", "tb/tb_top.sv"], top: tb_top }
simulator: { engine: verilator, timing: true, waveform: never }
coverage: { include: ["rtl/**"] }
tests:
  random: { seeds: [${Array.from({ length: RUNS }, (_, i) => i + 1).join(", ")}], plusargs: { OPS: "400" } }
regressions:
  bench: { tests: [random] }
resources: { cpu: 1, memory_mb: 256, compile_memory_mb: 2048, timeout_seconds: 300 }
`;

const db = await createTestDatabase();
const s = await startServer(db.url, { logLevel: "error" });
const o = await orgWithProject(s.base, "bench");
await s.db.query("UPDATE organizations SET plan = 'pro' WHERE id = $1", [o.org.id]);
await s.db.query("UPDATE projects SET max_concurrency = 64 WHERE id = $1", [o.project.id]);
await uploadSnapshot(o.c, o.project.id, snapshotOf(files));

async function runJob() {
  const id = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "bench" })).json.job.id as string;
  for (;;) {
    const j = (await o.c.get(`/api/v1/jobs/${id}`)).json.job;
    if (!["QUEUED", "RUNNING"].includes(j.state)) return id;
    await new Promise((r) => setTimeout(r, 250));
  }
}

const results = [];
for (const slots of SLOTS) {
  const worker = await startWorker({ apiUrl: s.base, name: `bench-${slots}`, sandbox: "docker", simImage: "verifycloud-sim:verilator", cpus: slots, memoryMb: Math.max(2048, slots * 256), pollIntervalMs: 100, workDir: join(tmpdir(), `vc-bench-${process.pid}-${slots}`) });
  if (results.length === 0) await runJob(); // warm the build cache
  const id = await runJob();
  await worker.stop();
  const job = (await s.db.query("SELECT state, summary FROM jobs WHERE id = $1", [id])).rows[0];
  const tasks = (await s.db.query("SELECT kind, state, duration_ms, started_at, finished_at, (result->>'cacheHit')::boolean AS cache_hit FROM tasks WHERE job_id = $1", [id])).rows;
  const tests = tasks.filter((t) => t.kind === "test");
  const build = tasks.find((t) => t.kind === "build");
  const first = Math.min(...tests.map((t) => new Date(t.started_at).getTime()));
  const last = Math.max(...tests.map((t) => new Date(t.finished_at).getTime()));
  const wall = (last - first) / 1000;
  const sum = tests.reduce((a, t) => a + t.duration_ms, 0) / 1000;
  const r = {
    sandboxSlots: slots,
    jobState: job.state,
    testRuns: tests.length,
    passed: tests.filter((t) => t.state === "PASSED").length,
    buildCacheHit: build?.cache_hit === true,
    testPhaseWallSeconds: +wall.toFixed(2),
    runsPerMinute: +((tests.length / wall) * 60).toFixed(1),
    perRunSeconds: stats(tests.map((t) => t.duration_ms / 1000)),
    sumOfRunSeconds: +sum.toFixed(1),
    effectiveParallelism: +(sum / wall).toFixed(2),
  };
  console.error(`slots=${slots}: ${r.runsPerMinute} runs/min, wall ${r.testPhaseWallSeconds}s, per-run p50 ${r.perRunSeconds.p50}s p95 ${r.perRunSeconds.p95}s, parallelism ${r.effectiveParallelism}, passed ${r.passed}/${r.testRuns}`);
  results.push(r);
}
writeFileSync(process.env.BENCH_OUT ?? "docs/benchmarks/sandbox.json", JSON.stringify({ benchmark: "real Verilator runs in the Docker sandbox", environment: environment(), runsPerJob: RUNS, results }, null, 2) + "\n");
await s.app.close();
await db.drop();
process.exit(0);
