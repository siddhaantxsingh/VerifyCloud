// Adversarial scheduler tests written during the 2026-10-08 audit. Each test
// reproduces a defect found by reading the code; it failed before the fix.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, FakeWorker, minimalConfig, orgWithProject, sleep, snapshotOf, startServer, uploadSnapshot, waitFor, type TestServer } from "./helpers.js";

let db: { url: string; drop: () => Promise<void> };
let s: TestServer;
beforeAll(async () => {
  db = await createTestDatabase();
  s = await startServer(db.url, { limits: { leaseSeconds: 3, reaperIntervalMs: 300 } as any });
});
afterAll(async () => {
  await s.app.close();
  await db.drop();
});

// workers claim across all tenants: park every other test's leftovers so each test sees only its own tasks
async function quiesce() {
  await s.db.query("UPDATE tasks SET state = 'CANCELLED', finished_at = now() WHERE state IN ('QUEUED','BLOCKED','RUNNING')");
  await s.db.query("UPDATE jobs SET state = 'CANCELLED', finished_at = now() WHERE state IN ('QUEUED','RUNNING')");
}

async function project(extra = "") {
  await quiesce();
  const o = await orgWithProject(s.base);
  await uploadSnapshot(o.c, o.project.id, snapshotOf({ "verifycloud.yaml": minimalConfig(extra), "rtl/a.sv": "module a; endmodule\n", "tb/tb.sv": "module tb; a u(); endmodule\n" }));
  return o;
}
const flakyConfig = () => `version: 1
project: { name: t }
rtl: { sources: ["rtl/*.sv"] }
testbench: { sources: ["tb/*.sv"], top: tb }
simulator: { engine: verilator }
tests:
  f: { retries: 2 }
regressions:
  r: { tests: [f] }
`;

async function buildDone(w: FakeWorker) {
  const c = await waitFor(() => w.claim(), 10_000, "build claim");
  expect(c.task.kind).toBe("build");
  const m = await w.upload(c.task.id, c.leaseToken, "model", "sim", Buffer.from("m"));
  await w.complete(c.task.id, c.leaseToken, { state: "PASSED", durationMs: 1, modelArtifactId: m.json.id });
}

describe("audit: scheduler correctness", () => {
  it("H2: a failing test with retries left is not re-queued into a job that already timed out", async () => {
    await quiesce();
    const o = await orgWithProject(s.base);
    await uploadSnapshot(o.c, o.project.id, snapshotOf({ "verifycloud.yaml": flakyConfig(), "rtl/a.sv": "module a; endmodule\n", "tb/tb.sv": "module tb; endmodule\n" }));
    const j = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "r" })).json.job;
    const w = await new FakeWorker(s.base).register();
    await buildDone(w);
    const t = await waitFor(() => w.claim(), 10_000, "test claim");
    // the job passes its deadline while the test is running
    await s.db.query("UPDATE jobs SET deadline_at = now() - interval '1 second' WHERE id = $1", [j.id]);
    await waitFor(async () => (await s.db.query("SELECT state FROM jobs WHERE id = $1", [j.id])).rows[0].state === "TIMED_OUT", 10_000, "deadline");
    const r = await w.complete(t.task.id, t.leaseToken, { state: "FAILED", durationMs: 1 });
    expect(r.status).toBe(200);
    const task = (await s.db.query("SELECT state FROM tasks WHERE id = $1", [t.task.id])).rows[0];
    expect(task.state).not.toBe("QUEUED");
    const summary = (await s.db.query("SELECT summary FROM jobs WHERE id = $1", [j.id])).rows[0].summary;
    expect(summary.queued ?? 0).toBe(0);
  });

  it("H3: completion and cancellation take locks in the same order (no deadlock, real result kept)", async () => {
    const o = await project();
    const j = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke", tests: ["t1"] })).json.job;
    const w = await new FakeWorker(s.base).register();
    await buildDone(w);
    const t = await waitFor(() => w.claim(), 10_000, "test claim");
    // a concurrent transaction behaves like cancel(): job row first, then the job's running tasks
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT 1 FROM jobs WHERE id = $1 FOR UPDATE", [j.id]);
      const completion = w.complete(t.task.id, t.leaseToken, { state: "PASSED", durationMs: 1 });
      await sleep(500); // completion is now waiting for a lock
      let txError: string | null = null;
      try {
        await c.query("UPDATE tasks SET cancel_requested = cancel_requested WHERE job_id = $1 AND state = 'RUNNING'", [j.id]);
        await c.query("COMMIT");
      } catch (e) {
        txError = (e as Error).message;
        await c.query("ROLLBACK").catch(() => {});
      }
      const r = await completion;
      expect(txError).toBeNull();
      expect(r.status).toBe(200);
      expect((await s.db.query("SELECT state FROM tasks WHERE id = $1", [t.task.id])).rows[0].state).toBe("PASSED");
    } finally {
      await c.end();
    }
  });

  it("H11: cancel does not deadlock with a claim (task row locked, then an event row that references the job)", async () => {
    const o = await project();
    const j = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke", tests: ["t1"] })).json.job;
    const w = await new FakeWorker(s.base).register();
    await buildDone(w);
    const t = await waitFor(() => w.claim(), 10_000, "test claim");
    // a concurrent transaction behaves like claim(): it holds the task row, then
    // inserts a job_events row (the foreign key takes KEY SHARE on the job row)
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("UPDATE tasks SET lease_expires_at = lease_expires_at WHERE id = $1", [t.task.id]);
      const cancel = o.c.post(`/api/v1/jobs/${j.id}/cancel`);
      await sleep(500); // cancel now holds the job row and waits for the task row
      let txError: string | null = null;
      try {
        await c.query("INSERT INTO job_events (org_id, project_id, job_id, type, data) VALUES ($1, $2, $3, 'TEST_STARTED', '{}')", [o.org.id, o.project.id, j.id]);
        await c.query("COMMIT");
      } catch (e) {
        txError = (e as Error).message;
        await c.query("ROLLBACK").catch(() => {});
      }
      const r = await cancel;
      expect(txError).toBeNull();
      expect(r.status).toBe(200);
    } finally {
      await c.end();
    }
  });

  it("M5: a retried completion (response lost) gets the recorded outcome, not LEASE_LOST", async () => {
    const o = await project();
    await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke", tests: ["t1"] });
    const w = await new FakeWorker(s.base).register();
    await buildDone(w);
    const t = await waitFor(() => w.claim(), 10_000, "test claim");
    const first = await w.complete(t.task.id, t.leaseToken, { state: "FAILED", durationMs: 1 });
    expect(first.status).toBe(200);
    const again = await w.complete(t.task.id, t.leaseToken, { state: "FAILED", durationMs: 1 });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ state: "FAILED", duplicate: true });
    // a different token for the same task is still rejected
    expect((await w.complete(t.task.id, "00000000-0000-0000-0000-000000000000", { state: "PASSED", durationMs: 1 })).status).toBe(409);
  });

  it("M6: an upload by a worker whose lease is gone is rejected and leaves no artifact", async () => {
    const o = await project();
    await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke", tests: ["t1"] });
    const a = await new FakeWorker(s.base).register("stale");
    const c = await waitFor(() => a.claim(), 10_000, "claim");
    await waitFor(async () => (await s.db.query("SELECT state FROM tasks WHERE id = $1", [c.task.id])).rows[0].state === "QUEUED", 15_000, "lease expiry");
    const before = (await s.db.query("SELECT count(*)::int AS n FROM artifacts WHERE task_id = $1", [c.task.id])).rows[0].n;
    const up = await a.upload(c.task.id, c.leaseToken, "log", "late.log", Buffer.from("late"));
    expect(up.status).toBe(409);
    expect((await s.db.query("SELECT count(*)::int AS n FROM artifacts WHERE task_id = $1", [c.task.id])).rows[0].n).toBe(before);
  });

  it("M7: usage of attempts that are retried is recorded (and never twice)", async () => {
    const o = await project();
    const j = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke", tests: ["t1"] })).json.job;
    const w = await new FakeWorker(s.base).register();
    const b = await waitFor(() => w.claim(), 10_000, "build claim");
    // the server bounds reported durations by the time the lease was actually
    // held (audit 2026-10-14), so the fake worker really holds it for 1.5 s
    await sleep(1600);
    await w.complete(b.task.id, b.leaseToken, { state: "ERROR", retryable: true, error: "infra", durationMs: 1500 });
    await w.complete(b.task.id, b.leaseToken, { state: "ERROR", retryable: true, error: "infra", durationMs: 1500 }); // duplicate report
    const u = (await s.db.query("SELECT kind, quantity FROM usage_records WHERE job_id = $1 AND kind = 'worker_seconds'", [j.id])).rows;
    expect(u).toHaveLength(1);
    expect(Number(u[0].quantity)).toBeCloseTo(1.5);
  });

  it("flaky re-runs do not consume the infrastructure retry budget", async () => {
    await quiesce();
    const o = await orgWithProject(s.base);
    await uploadSnapshot(o.c, o.project.id, snapshotOf({ "verifycloud.yaml": flakyConfig(), "rtl/a.sv": "module a; endmodule\n", "tb/tb.sv": "module tb; endmodule\n" }));
    await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "r" });
    const w = await new FakeWorker(s.base).register();
    await buildDone(w);
    for (let i = 0; i < 2; i++) {
      const t = await waitFor(() => w.claim(), 10_000, `run ${i}`);
      expect((await w.complete(t.task.id, t.leaseToken, { state: "FAILED", durationMs: 1 })).json.requeued).toBe(true);
    }
    const t3 = await waitFor(() => w.claim(), 10_000, "third run");
    const r = await w.complete(t3.task.id, t3.leaseToken, { state: "ERROR", retryable: true, error: "docker hiccup", durationMs: 1 });
    expect(r.json.requeued).toBe(true);
  });

  it("M8: an event committed after a later-numbered event is still delivered", async () => {
    const o = await project();
    const j = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke", tests: ["t1"] })).json.job;
    const got: number[] = [];
    const unsub = await s.app.ctx.events.subscribe({ orgIds: new Set([o.org.id]), jobId: j.id, send: (e) => got.push(e.id) }, undefined);
    const a = new pg.Client({ connectionString: db.url });
    const b = new pg.Client({ connectionString: db.url });
    await a.connect();
    await b.connect();
    try {
      const ins = "INSERT INTO job_events (org_id, project_id, job_id, type, data) VALUES ($1,$2,$3,'TEST_STARTED','{}') RETURNING id";
      await a.query("BEGIN");
      const idA = Number((await a.query(ins, [o.org.id, o.project.id, j.id])).rows[0].id);
      await b.query("BEGIN");
      const idB = Number((await b.query(ins, [o.org.id, o.project.id, j.id])).rows[0].id);
      await b.query("SELECT pg_notify('vc_events', $1)", [String(idB)]);
      await b.query("COMMIT");
      await waitFor(async () => got.includes(idB), 5_000, "later id delivered");
      await a.query("SELECT pg_notify('vc_events', $1)", [String(idA)]);
      await a.query("COMMIT");
      await waitFor(async () => got.includes(idA), 5_000, "earlier id delivered after its late commit");
      expect(got.filter((x) => x === idA)).toHaveLength(1);
      expect(got.filter((x) => x === idB)).toHaveLength(1);
    } finally {
      unsub();
      await a.end();
      await b.end();
    }
  });

  it("M8b: with thousands of recent events, a new event is still delivered promptly (no window stall)", async () => {
    const o = await project();
    const j = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke", tests: ["t1"] })).json.job;
    // 3000 recent events, committed and announced
    await s.db.query("INSERT INTO job_events (org_id, project_id, job_id, type, data) SELECT $1, $2, $3, 'LOG', '{}' FROM generate_series(1, 3000)", [o.org.id, o.project.id, j.id]);
    await s.db.query("SELECT pg_notify('vc_events', '0')");
    await sleep(1000);
    const got: number[] = [];
    const unsub = await s.app.ctx.events.subscribe({ orgIds: new Set([o.org.id]), jobId: j.id, send: (e) => got.push(e.id) }, undefined);
    try {
      const id = Number((await s.db.query("INSERT INTO job_events (org_id, project_id, job_id, type, data) VALUES ($1,$2,$3,'TEST_STARTED','{}') RETURNING id", [o.org.id, o.project.id, j.id])).rows[0].id);
      await s.db.query("SELECT pg_notify('vc_events', $1)", [String(id)]);
      await waitFor(async () => got.includes(id), 5_000, "new event delivered");
    } finally {
      unsub();
    }
  });

  it("M9: post-job side effects happen once, and a lost post-processing run is recoverable", async () => {
    const { postJob } = await import("../src/postjob.js");
    const o = await project();
    await o.c.post(`/api/v1/projects/${o.project.id}/notifications`, { kind: "email", target: "team@example.com", events: ["regression_failed"] });
    const j = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke", tests: ["t1"] })).json.job;
    await (await new FakeWorker(s.base).register()).drain(() => "FAILED");
    const count = async () => (await s.db.query("SELECT count(*)::int AS n FROM notifications WHERE payload->>'jobId' = $1", [j.id])).rows[0].n;
    await waitFor(async () => (await count()) === 1, 10_000, "notification");
    await postJob(s.app.ctx, j.id); // duplicate invocation (hook + sweep)
    expect(await count()).toBe(1);
    // simulate a crash before post-processing committed: marker cleared, outbox empty
    await s.db.query("DELETE FROM notifications WHERE payload->>'jobId' = $1", [j.id]);
    await s.db.query("UPDATE jobs SET post_processed_at = NULL WHERE id = $1", [j.id]);
    const pending = (await s.db.query("SELECT id FROM jobs WHERE post_processed_at IS NULL AND finished_at IS NOT NULL AND id = $1", [j.id])).rows;
    expect(pending).toHaveLength(1); // what the sweep selects
    await postJob(s.app.ctx, j.id);
    expect(await count()).toBe(1);
  });

  it("H1: a worker marked offline after an outage is told to re-register (401), not silently locked out", async () => {
    const w = await new FakeWorker(s.base).register("sleepy");
    await s.db.query("UPDATE workers SET state = 'offline' WHERE id = $1", [w.id]);
    const hb = await w.call("POST", "/workers/heartbeat", { body: { running: 0 } });
    expect(hb.status).toBe(401);
    expect(hb.json.error.code).toBe("WORKER_REREGISTER");
  });

  it("chaos: random completions, crashes, duplicate and stale reports, infra errors and cancels keep every invariant", async () => {
    await quiesce();
    const projects = await Promise.all([0, 1, 2].map(async () => {
      const o = await orgWithProject(s.base);
      await uploadSnapshot(o.c, o.project.id, snapshotOf({ "verifycloud.yaml": minimalConfig(), "rtl/a.sv": "module a; endmodule\n", "tb/tb.sv": "module tb; a u(); endmodule\n" }));
      return o;
    }));
    const jobs: { o: any; id: string }[] = [];
    for (const o of projects) for (let k = 0; k < 4; k++) jobs.push({ o, id: (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke" })).json.job.id });
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const workers = await Promise.all(Array.from({ length: 8 }, (_, i) => new FakeWorker(s.base).register(`chaos${i}`)));
    const stale: { w: FakeWorker; id: string; lease: string }[] = [];
    const deadline = Date.now() + 60_000;
    const terminal = async () => (await s.db.query("SELECT count(*)::int AS n FROM jobs WHERE id = ANY($1) AND state IN ('QUEUED','RUNNING')", [jobs.map((j) => j.id)])).rows[0].n === 0;
    await Promise.all(
      workers.map(async (w) => {
        while (Date.now() < deadline && !(await terminal())) {
          if (rnd() < 0.03) await jobs[Math.floor(rnd() * jobs.length)]!.o.c.post(`/api/v1/jobs/${jobs[Math.floor(rnd() * jobs.length)]!.id}/cancel`).catch(() => {});
          if (stale.length && rnd() < 0.2) {
            const st = stale.shift()!;
            const r = await st.w.complete(st.id, st.lease, { state: "PASSED", durationMs: 1 });
            expect([200, 409]).toContain(r.status);
          }
          const c = await w.claim();
          if (!c) {
            await sleep(50);
            continue;
          }
          const x = rnd();
          if (x < 0.1) {
            stale.push({ w, id: c.task.id, lease: c.leaseToken }); // crash: never reports; may report much later
            continue;
          }
          let rep: Record<string, unknown>;
          if (c.task.kind === "build") {
            const m = await w.upload(c.task.id, c.leaseToken, "model", "sim", Buffer.from("m"));
            rep = x < 0.2 ? { state: "ERROR", retryable: true, error: "infra", durationMs: 2 } : { state: "PASSED", durationMs: 2, modelArtifactId: m.json.id };
          } else rep = x < 0.2 ? { state: "ERROR", retryable: true, error: "infra", durationMs: 2 } : { state: x < 0.4 ? "FAILED" : "PASSED", durationMs: 2 };
          const r1 = await w.complete(c.task.id, c.leaseToken, rep);
          expect([200, 409]).toContain(r1.status);
          if (rnd() < 0.3) expect([200, 409]).toContain((await w.complete(c.task.id, c.leaseToken, rep)).status); // duplicate report
        }
      }),
    );
    await waitFor(terminal, 60_000, "all jobs terminal");
    const ids = jobs.map((j) => j.id);
    // every task terminal; no task left leased
    const open = (await s.db.query("SELECT count(*)::int AS n FROM tasks WHERE job_id = ANY($1) AND (state IN ('QUEUED','RUNNING','BLOCKED') OR lease_expires_at IS NOT NULL)", [ids])).rows[0].n;
    expect(open).toBe(0);
    // one usage record per (task, attempt, kind) at most; never more attempts billed than claimed
    const dup = (await s.db.query("SELECT source_key, count(*) FROM usage_records WHERE job_id = ANY($1) GROUP BY 1 HAVING count(*) > 1", [ids])).rowCount;
    expect(dup).toBe(0);
    const overBilled = (await s.db.query(
      `SELECT t.id FROM tasks t JOIN usage_records u ON u.source_key LIKE 'task:' || t.id || ':%:worker_seconds' WHERE t.job_id = ANY($1)
        GROUP BY t.id, t.attempt HAVING count(*) > t.attempt`, [ids])).rowCount;
    expect(overBilled).toBe(0);
    // job summaries agree with their tasks; finished jobs have a finish time
    for (const id of ids) {
      const j = (await s.db.query("SELECT state, summary, finished_at FROM jobs WHERE id = $1", [id])).rows[0];
      const t = (await s.db.query("SELECT count(*) FILTER (WHERE state='PASSED')::int AS passed, count(*) FILTER (WHERE state IN ('FAILED','ERROR'))::int AS failed FROM tasks WHERE job_id = $1 AND kind = 'test'", [id])).rows[0];
      expect(j.finished_at).not.toBeNull();
      expect(j.summary.passed ?? 0).toBe(t.passed);
      if (j.state === "SUCCEEDED") expect(t.failed).toBe(0);
    }
  }, 180_000);
});

