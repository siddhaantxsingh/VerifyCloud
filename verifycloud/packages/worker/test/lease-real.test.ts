// Lease fencing with real worker processes (audit 2026-10-14).
//
// Earlier lease tests drive the internal API with an in-process fake worker.
// Here every worker is a separate OS process running the production worker
// (packages/worker/src/main.ts) with the Docker sandbox and real Verilator,
// and the tests do what happens in production:
//   - SIGKILL a worker in the middle of a simulation,
//   - SIGSTOP a worker past its lease (GC pause, VM freeze, partition) and
//     resume it after another worker has finished the task: its late uploads
//     and its completion must be refused, and the recorded result must stay,
//   - run workers whose wall clocks are hours off, or jump by 40 days during
//     a run: leases are decided on the database clock, so nothing may be lost
//     or double-run, and recorded durations must stay sane.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, orgWithProject, ROOT, sleep, snapshotOf, startServer, uploadSnapshot, waitFor, type TestServer } from "../../server/test/helpers.js";

const IMAGE = process.env.SIM_IMAGE ?? "verifycloud-sim:verilator";
const dockerOk = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;
const d = dockerOk ? describe : describe.skip;
const LEASE_SECONDS = 6;

let db: { url: string; drop: () => Promise<void> };
let s: TestServer;
const procs: Proc[] = [];

beforeAll(async () => {
  if (!dockerOk) return;
  db = await createTestDatabase();
  s = await startServer(db.url, { limits: { leaseSeconds: LEASE_SECONDS, reaperIntervalMs: 500 } as any });
}, 60_000);

afterAll(async () => {
  for (const p of procs) p.kill("SIGKILL");
  if (!dockerOk) return;
  await s?.app.close();
  await db?.drop();
});

interface Proc {
  name: string;
  child: ChildProcess;
  out: string[];
  workerIds: string[];
  kill(sig: NodeJS.Signals): void;
}

/** Start the production worker as its own process (own process group). */
function startWorkerProcess(name: string, env: Record<string, string> = {}, preloadClock = false): Proc {
  const args = ["--import", "tsx"];
  if (preloadClock) args.push("--import", join(import.meta.dirname, "fixtures", "clock.mjs"));
  args.push(join(ROOT, "packages", "worker", "src", "main.ts"));
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      API_URL: s.base,
      WORKER_REGISTRATION_TOKEN: "dev-worker-token",
      WORKER_NAME: name,
      SANDBOX: "docker",
      SIM_IMAGE: IMAGE,
      WORKER_CPUS: "2",
      WORKER_MEMORY_MB: "4096",
      POLL_INTERVAL_MS: "200",
      WORK_DIR: join(process.env.TMPDIR ?? "/tmp", `vc-lease-real-${process.pid}`),
      ...env,
    },
  });
  const p: Proc = {
    name,
    child,
    out: [],
    workerIds: [],
    kill(sig) {
      try {
        process.kill(-child.pid!, sig);
      } catch {
        /* already gone */
      }
    },
  };
  const onData = (b: Buffer) => {
    for (const line of b.toString().split("\n")) {
      if (!line.trim()) continue;
      p.out.push(line);
      const m = /"workerId":"([0-9a-f-]{36})"/.exec(line);
      if (m) p.workerIds.push(m[1]!);
    }
  };
  child.stdout!.on("data", onData);
  child.stderr!.on("data", onData);
  procs.push(p);
  return p;
}

const cfg = (n: number, sleepSeconds: number) => `version: 1
project: { name: lease-real }
rtl: { sources: ["rtl/*.sv"] }
testbench: { sources: ["tb/*.sv"], top: tb }
simulator: { engine: verilator, timing: true }
resources: { cpu: 1, memory_mb: 256, compile_memory_mb: 1024, timeout_seconds: 120 }
tests:
${Array.from({ length: n }, (_, i) => `  t${i}: {}`).join("\n")}
regressions:
  default: { tests: [${Array.from({ length: n }, (_, i) => `t${i}`).join(", ")}] }
`;
// a test that takes real (wall-clock) time, so workers can be hit mid-run
const files = (n: number, sleepSeconds: number) => ({
  "verifycloud.yaml": cfg(n, sleepSeconds),
  "rtl/dut.sv": "module dut(input logic a, output logic y); assign y = ~a; endmodule\n",
  "tb/tb.sv": `module tb; logic a, y; dut u(.a(a), .y(y)); initial begin a = 0; $system("sleep ${sleepSeconds}"); #1 if (y !== 1'b1) $fatal(1, "bad"); $display("ok"); $finish; end endmodule\n`,
});

async function startJob(n: number, sleepSeconds: number) {
  // other tests' leftovers must not be claimed by this test's workers
  await s.db.query("UPDATE tasks SET state = 'CANCELLED', finished_at = now() WHERE state IN ('QUEUED','BLOCKED','RUNNING')");
  await s.db.query("UPDATE jobs SET state = 'CANCELLED', finished_at = now() WHERE state IN ('QUEUED','RUNNING')");
  const o = await orgWithProject(s.base, "lease");
  await uploadSnapshot(o.c, o.project.id, snapshotOf(files(n, sleepSeconds)));
  const r = await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "default" });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return { o, jobId: r.json.job.id as string };
}

const finalJob = (o: Awaited<ReturnType<typeof orgWithProject>>, id: string, ms = 600_000) =>
  waitFor(async () => {
    const j = (await o.c.get(`/api/v1/jobs/${id}`)).json.job;
    return ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "RESOURCE_EXCEEDED", "ERROR"].includes(j.state) ? j : null;
  }, ms, `job ${id}`);

const tasksOf = async (jobId: string) => (await s.db.query("SELECT * FROM tasks WHERE job_id = $1 ORDER BY kind, test_name", [jobId])).rows;

/** Invariants that must hold for every finished job, whatever happened to the workers. */
async function checkInvariants(jobId: string) {
  const tasks = await tasksOf(jobId);
  for (const t of tasks) {
    expect(["PASSED"], `${t.kind} ${t.test_name}: ${t.state} ${t.error ?? ""}`).toContain(t.state);
    expect(t.lease_worker, "terminal task keeps no lease holder").toBeNull();
    expect(t.attempt).toBeLessThanOrEqual(t.max_attempts);
    expect(t.duration_ms).toBeGreaterThanOrEqual(0);
    expect(t.duration_ms).toBeLessThan(10 * 60_000);
  }
  // exactly one log artifact per test task: a killed or stale attempt never attaches one
  const logs = (await s.db.query("SELECT task_id, count(*)::int AS n FROM artifacts WHERE job_id = $1 AND kind = 'log' GROUP BY task_id", [jobId])).rows;
  for (const t of tasks.filter((x) => x.kind === "test")) expect(logs.find((l) => l.task_id === t.id)?.n ?? 0, `log artifacts of ${t.test_name}`).toBe(1);
  // usage is never negative
  const neg = (await s.db.query("SELECT count(*)::int AS n FROM usage_records WHERE job_id = $1 AND quantity < 0", [jobId])).rows[0].n;
  expect(neg).toBe(0);
  return tasks;
}

const runningOn = async (jobId: string, workerIds: string[]) =>
  (await s.db.query("SELECT * FROM tasks WHERE job_id = $1 AND kind = 'test' AND state = 'RUNNING' AND lease_worker = ANY($2::uuid[])", [jobId, workerIds])).rows;

d("lease fencing with real worker processes", () => {
  it("SIGKILL of a worker mid-simulation: its tasks are re-run elsewhere, recorded once; its orphaned sandboxes are removed on restart", async () => {
    const tag = randomBytes(3).toString("hex");
    const victim = startWorkerProcess(`victim-${tag}`);
    const { o, jobId } = await startJob(4, 6);
    // wait until the victim is in the middle of a simulation
    const held = await waitFor(async () => {
      const r = await runningOn(jobId, victim.workerIds);
      return r.length ? r : null;
    }, 300_000, "victim running a test");
    await sleep(1500);
    victim.kill("SIGKILL");
    const killedIds = held.map((t) => t.id);
    const survivor = startWorkerProcess(`survivor-${tag}`);
    const job = await finalJob(o, jobId);
    expect(job.state).toBe("SUCCEEDED");
    const tasks = await checkInvariants(jobId);
    for (const id of killedIds) {
      const t = tasks.find((x) => x.id === id)!;
      expect(t.attempt, `${t.test_name} re-run after the kill`).toBeGreaterThanOrEqual(2);
    }
    // restarting a worker under the same name removes the killed process's leftover containers (H5)
    const again = startWorkerProcess(victim.name);
    await waitFor(async () => again.workerIds.length > 0, 60_000, "restarted victim registered");
    const leftovers = spawnSync("docker", ["ps", "-aq", "--filter", `label=vc.owner=${victim.name}`], { encoding: "utf8" }).stdout.trim();
    expect(leftovers).toBe("");
    again.kill("SIGTERM");
    survivor.kill("SIGTERM");
  }, 900_000);

  it("SIGSTOP past the lease: the frozen worker's late uploads and completion are refused and the recorded result stands", async () => {
    const tag = randomBytes(3).toString("hex");
    const frozen = startWorkerProcess(`frozen-${tag}`);
    const { o, jobId } = await startJob(2, 8);
    const held = await waitFor(async () => {
      const r = await runningOn(jobId, frozen.workerIds);
      return r.length ? r : null;
    }, 300_000, "frozen worker running a test");
    frozen.kill("SIGSTOP");
    const helper = startWorkerProcess(`helper-${tag}`);
    const job = await finalJob(o, jobId);
    expect(job.state).toBe("SUCCEEDED");
    const before = await tasksOf(jobId);
    const artifactsBefore = (await s.db.query("SELECT id FROM artifacts WHERE job_id = $1 ORDER BY id", [jobId])).rows.map((r) => r.id);
    const staleBefore = s.app.ctx.metrics.staleReports.get();
    // wake the frozen worker: its sandbox has finished meanwhile; it now tries to report
    frozen.kill("SIGCONT");
    await waitFor(async () => frozen.out.some((l) => /lease lost/.test(l)), 120_000, "frozen worker notices the lost lease");
    await sleep(2000);
    const after = await tasksOf(jobId);
    for (const t of held) {
      const b = before.find((x) => x.id === t.id)!;
      const a = after.find((x) => x.id === t.id)!;
      expect(a.state).toBe(b.state);
      expect(a.attempt).toBe(b.attempt);
      expect(a.attempt).toBeGreaterThanOrEqual(2);
      expect(a.duration_ms).toBe(b.duration_ms);
      expect(a.finished_at.getTime()).toBe(b.finished_at.getTime());
    }
    const artifactsAfter = (await s.db.query("SELECT id FROM artifacts WHERE job_id = $1 ORDER BY id", [jobId])).rows.map((r) => r.id);
    expect(artifactsAfter).toEqual(artifactsBefore);
    expect(s.app.ctx.metrics.staleReports.get()).toBeGreaterThan(staleBefore);
    await checkInvariants(jobId);
    frozen.kill("SIGTERM");
    helper.kill("SIGTERM");
  }, 900_000);

  it("wall-clock skew of ±2 h and a 40-day clock step during runs: no lease is lost, nothing is re-run, durations stay sane", async () => {
    const tag = randomBytes(3).toString("hex");
    const expiredBefore = s.app.ctx.metrics.leaseExpired.get();
    const ahead = startWorkerProcess(`ahead-${tag}`, { VC_CLOCK_SKEW_MS: String(2 * 3600_000) }, true);
    const behind = startWorkerProcess(`behind-${tag}`, { VC_CLOCK_SKEW_MS: String(-2 * 3600_000) }, true);
    const stepper = startWorkerProcess(`stepper-${tag}`, { VC_CLOCK_JUMP_AFTER_MS: "15000", VC_CLOCK_JUMP_MS: String(40 * 24 * 3600_000) }, true);
    const { o, jobId } = await startJob(6, 4);
    const job = await finalJob(o, jobId);
    expect(job.state).toBe("SUCCEEDED");
    const tasks = await checkInvariants(jobId);
    for (const t of tasks) expect(t.attempt, `${t.kind} ${t.test_name} ran once`).toBe(1);
    expect(s.app.ctx.metrics.leaseExpired.get(), "no lease expired").toBe(expiredBefore);
    for (const p of [ahead, behind, stepper]) p.kill("SIGTERM");
  }, 900_000);
});
