// Scheduler throughput and correctness under concurrent workers (no
// simulation: fake workers claim and complete immediately), for 1/5/10/25
// workers. Measures claim latency, completed tasks per second, and checks
// that every task ran exactly once.
//   npx tsx bench/scheduler.ts > docs/benchmarks/scheduler.json
import { createTestDatabase, FakeWorker, orgWithProject, snapshotOf, startServer, uploadSnapshot } from "../packages/server/test/helpers.js";
import { environment, stats } from "./env.js";

const TASKS_PER_JOB = 101; // build + 100 test runs
const JOBS = 4;

const config = `version: 1
project: { name: bench }
rtl: { sources: ["rtl/*.sv"] }
testbench: { sources: ["tb/*.sv"], top: tb }
simulator: { engine: verilator }
tests:
  t: { seeds: [${Array.from({ length: TASKS_PER_JOB - 1 }, (_, i) => i + 1).join(", ")}] }
regressions:
  r: { tests: [t] }
`;

async function run(workers: number) {
  const db = await createTestDatabase();
  const s = await startServer(db.url, {}, { background: true });
  const o = await orgWithProject(s.base, "bench");
  await s.db.query("UPDATE organizations SET plan = 'pro' WHERE id = $1", [o.org.id]);
  await s.db.query("UPDATE plans SET max_concurrent_tasks = 1000, max_concurrent_jobs = 100 WHERE name = 'pro'");
  await s.db.query("UPDATE projects SET max_concurrency = 256 WHERE id = $1", [o.project.id]);
  await uploadSnapshot(o.c, o.project.id, snapshotOf({ "verifycloud.yaml": config, "rtl/a.sv": "module a; endmodule\n", "tb/tb.sv": "module tb; endmodule\n" }));
  for (let j = 0; j < JOBS; j++) await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "r" });
  const total = JOBS * TASKS_PER_JOB;
  const claimMs: number[] = [];
  const completeMs: number[] = [];
  const done = new Map<string, number>();
  const fleet = await Promise.all(Array.from({ length: workers }, (_, i) => new FakeWorker(s.base).register(`w${i}`)));
  const t0 = performance.now();
  let idle = 0;
  await Promise.all(
    fleet.map(async (w) => {
      for (;;) {
        const a = performance.now();
        const c = await w.claim(4, 8192);
        claimMs.push(performance.now() - a);
        if (!c) {
          if (done.size >= total || ++idle > workers * 200) return;
          await new Promise((r) => setTimeout(r, 20));
          continue;
        }
        const b = performance.now();
        if (c.task.kind === "build") {
          const m = await w.upload(c.task.id, c.leaseToken, "model", "sim", Buffer.from("m"));
          await w.complete(c.task.id, c.leaseToken, { state: "PASSED", durationMs: 1, modelArtifactId: m.json.id });
        } else await w.complete(c.task.id, c.leaseToken, { state: "PASSED", durationMs: 1 });
        completeMs.push(performance.now() - b);
        done.set(c.task.id, (done.get(c.task.id) ?? 0) + 1);
      }
    }),
  );
  const seconds = (performance.now() - t0) / 1000;
  const db2 = await s.db.query("SELECT count(*) FILTER (WHERE state = 'PASSED')::int AS passed, count(*) FILTER (WHERE attempt > 1)::int AS retried, count(*)::int AS total FROM tasks");
  const jobs = await s.db.query("SELECT count(*) FILTER (WHERE state = 'SUCCEEDED')::int AS ok FROM jobs");
  const duplicates = [...done.values()].filter((n) => n > 1).length;
  await s.app.close();
  await db.drop();
  return {
    workers,
    tasks: total,
    seconds: +seconds.toFixed(2),
    tasksPerSecond: +(total / seconds).toFixed(1),
    claimLatencyMs: stats(claimMs),
    completeLatencyMs: stats(completeMs),
    allTasksPassed: db2.rows[0].passed === total,
    jobsSucceeded: jobs.rows[0].ok,
    tasksExecutedTwice: duplicates,
    tasksRetried: db2.rows[0].retried,
  };
}

const results = [];
for (const w of [1, 5, 10, 25]) {
  const r = await run(w);
  console.error(`workers=${w}: ${r.tasksPerSecond} tasks/s, claim p95 ${r.claimLatencyMs.p95} ms, complete p95 ${r.completeLatencyMs.p95} ms, all passed ${r.allTasksPassed}, duplicates ${r.tasksExecutedTwice}`);
  if (!r.allTasksPassed || r.jobsSucceeded !== JOBS) throw new Error(`benchmark invalid: not every task completed (${JSON.stringify(r)})`);
  results.push(r);
}
console.log(JSON.stringify({ benchmark: "scheduler (fake workers, no simulation)", environment: environment(), jobs: JOBS, tasksPerJob: TASKS_PER_JOB, results }, null, 2));
process.exit(0);
