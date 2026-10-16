// Failing-first tests from the 2026-10-14 audit: worker-reported durations.
//
// Leases are decided with the database clock (now()), so worker clock skew
// cannot steal or extend a lease. But the worker measured run time with the
// wall clock (Date.now()) and the server stored whatever it was sent:
//  - a clock step backwards during a run gave negative usage (billing),
//  - a clock step forwards (or a hostile worker) gave a duration above the
//    int range of tasks.duration_ms, so the completion failed with a 500 and
//    the recorded result was lost,
//  - a missing or non-numeric duration became NaN usage rows,
//  - a fractional duration (from a monotonic clock) was refused by the int column.
// The server now clamps the reported duration to [0, time since the lease
// was granted by the database clock] and rounds it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, FakeWorker, minimalConfig, orgWithProject, snapshotOf, startServer, uploadSnapshot, waitFor, type TestServer } from "./helpers.js";

let db: { url: string; drop: () => Promise<void> };
let s: TestServer;
beforeAll(async () => {
  db = await createTestDatabase();
  s = await startServer(db.url, { limits: { leaseSeconds: 30, reaperIntervalMs: 300 } as any });
});
afterAll(async () => {
  await s.app.close();
  await db.drop();
});

async function quiesce() {
  await s.db.query("UPDATE tasks SET state = 'CANCELLED', finished_at = now() WHERE state IN ('QUEUED','BLOCKED','RUNNING')");
  await s.db.query("UPDATE jobs SET state = 'CANCELLED', finished_at = now() WHERE state IN ('QUEUED','RUNNING')");
}

/** A job with one test; returns a worker holding the lease on that test. */
async function heldTest() {
  await quiesce();
  const o = await orgWithProject(s.base);
  await uploadSnapshot(o.c, o.project.id, snapshotOf({ "verifycloud.yaml": minimalConfig(), "rtl/a.sv": "module a; endmodule\n", "tb/tb.sv": "module tb; a u(); endmodule\n" }));
  const job = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke", tests: ["t1"] })).json.job;
  const w = await new FakeWorker(s.base).register("clock");
  const b = await waitFor(() => w.claim(), 10_000, "build claim");
  const m = await w.upload(b.task.id, b.leaseToken, "model", "sim", Buffer.from("m"));
  expect((await w.complete(b.task.id, b.leaseToken, { state: "PASSED", durationMs: 1, modelArtifactId: m.json.id })).status).toBe(200);
  const t = await waitFor(() => w.claim(), 10_000, "test claim");
  return { w, t, job };
}

const usageOf = async (taskJob: string) =>
  (await s.db.query("SELECT kind, quantity::float8 AS q, quantity::text AS raw FROM usage_records WHERE job_id = $1 AND kind IN ('worker_seconds','simulation_seconds','cpu_seconds')", [taskJob])).rows as { kind: string; q: number; raw: string }[];

describe("audit 2026-10-14: worker-reported durations", () => {
  it("a clock step backwards (negative duration) never records negative usage or duration", async () => {
    const { w, t, job } = await heldTest();
    const r = await w.complete(t.task.id, t.leaseToken, { state: "PASSED", durationMs: -3_600_000, cpuSeconds: -5 });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const row = (await s.db.query("SELECT duration_ms FROM tasks WHERE id = $1", [t.task.id])).rows[0];
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    for (const u of await usageOf(job.id)) expect(u.q, `${u.kind}=${u.raw}`).toBeGreaterThanOrEqual(0);
  });

  it("a clock step forwards (30 days) still records the result, bounded by the server-observed run time", async () => {
    const { w, t, job } = await heldTest();
    const r = await w.complete(t.task.id, t.leaseToken, { state: "PASSED", durationMs: 30 * 24 * 3600 * 1000 });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const row = (await s.db.query("SELECT state, duration_ms FROM tasks WHERE id = $1", [t.task.id])).rows[0];
    expect(row.state).toBe("PASSED");
    // the lease was granted moments ago by the database clock
    expect(row.duration_ms).toBeLessThan(60_000);
    for (const u of await usageOf(job.id)) expect(u.q, `${u.kind}=${u.raw}`).toBeLessThan(60);
  });

  it("missing or non-numeric durations do not produce NaN usage; fractional durations are accepted", async () => {
    const a = await heldTest();
    const r1 = await a.w.complete(a.t.task.id, a.t.leaseToken, { state: "PASSED", durationMs: "soon" });
    expect(r1.status, JSON.stringify(r1.json)).toBe(200);
    for (const u of await usageOf(a.job.id)) expect(u.raw, u.kind).not.toBe("NaN");

    const b = await heldTest();
    const r2 = await b.w.complete(b.t.task.id, b.t.leaseToken, { state: "PASSED", durationMs: 12.75 });
    expect(r2.status, JSON.stringify(r2.json)).toBe(200);
    expect((await s.db.query("SELECT duration_ms FROM tasks WHERE id = $1", [b.t.task.id])).rows[0].duration_ms).toBeLessThanOrEqual(13);
  });
});
