// Job queue and scheduler: idempotency, single execution, lease expiry and
// recovery, retries, cancellation, timeouts, partial failures, fairness and
// quotas. Uses fake workers speaking the real internal API.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client, createTestDatabase, FakeWorker, minimalConfig, orgWithProject, sleep, snapshotOf, startServer, uploadSnapshot, waitFor, type TestServer } from "./helpers.js";

let db: { url: string; drop: () => Promise<void> };
let s: TestServer;
beforeAll(async () => {
  db = await createTestDatabase();
  s = await startServer(db.url, { limits: { leaseSeconds: 2, reaperIntervalMs: 300 } as any });
});
afterAll(async () => {
  await s.app.close();
  await db.drop();
});

const files = { "verifycloud.yaml": minimalConfig(), "rtl/a.sv": "module a; endmodule\n", "tb/tb.sv": "module tb; a u(); endmodule\n" };

async function project() {
  const o = await orgWithProject(s.base);
  await uploadSnapshot(o.c, o.project.id, snapshotOf(files));
  return o;
}
const job = (c: Client, id: string) => c.get(`/api/v1/jobs/${id}`).then((r) => r.json.job);

describe("job creation", () => {
  it("a snapshot with a valid configuration makes its regressions runnable before any job exists", async () => {
    const o = await project();
    const r = await o.c.get(`/api/v1/projects/${o.project.id}/regressions`);
    expect(r.json.regressions).toEqual([expect.objectContaining({ name: "smoke", tests: ["t1", "t2"], last_job_id: null, runs: 0 })]);
  });

  it("is idempotent per Idempotency-Key, also under concurrent requests", async () => {
    const o = await project();
    const reqs = await Promise.all(Array.from({ length: 8 }, () => o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke" }, { "Idempotency-Key": "ci-run-123456" })));
    const ids = new Set(reqs.map((r) => r.json.job.id));
    expect(ids.size).toBe(1);
    expect(reqs.filter((r) => r.status === 201).length).toBe(1);
    const tasks = await s.db.query("SELECT count(*)::int AS n FROM tasks WHERE job_id = $1", [[...ids][0]]);
    expect(tasks.rows[0].n).toBe(5); // build + t1 + t2 x3 seeds
  });

  it("refuses an invalid configuration with line-numbered issues", async () => {
    const o = await orgWithProject(s.base);
    await uploadSnapshot(o.c, o.project.id, snapshotOf({ ...files, "verifycloud.yaml": "version: 1\nproject: {name: x}\nbogus: true\n" }));
    const r = await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, {});
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("INVALID_PROJECT_CONFIG");
    expect(r.json.error.details.some((i: any) => i.line === 3 && i.path === "bogus")).toBe(true);
  });
});

describe("execution", () => {
  it("never hands one task to two workers, and runs a job to completion", async () => {
    const o = await project();
    const j = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke" })).json.job;
    const workers = await Promise.all(Array.from({ length: 6 }, (_, i) => new FakeWorker(s.base).register(`w${i}`)));
    const seen = new Map<string, number>();
    // all workers claim concurrently until nothing is left
    await Promise.all(
      workers.map(async (w) => {
        for (let i = 0; i < 20; i++) {
          const c = await w.claim();
          if (!c) {
            await sleep(30);
            continue;
          }
          seen.set(c.task.id, (seen.get(c.task.id) ?? 0) + 1);
          if (c.task.kind === "build") {
            const m = await w.upload(c.task.id, c.leaseToken, "model", "sim", Buffer.from("x"));
            await w.complete(c.task.id, c.leaseToken, { state: "PASSED", durationMs: 1, modelArtifactId: m.json.id });
          } else await w.complete(c.task.id, c.leaseToken, { state: "PASSED", durationMs: 1 });
        }
      }),
    );
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    const mine = (await s.db.query("SELECT id FROM tasks WHERE job_id = $1", [j.id])).rows.map((r) => r.id);
    expect(mine.every((id) => seen.get(id) === 1)).toBe(true);
    expect((await job(o.c, j.id)).state).toBe("SUCCEEDED");
  });

  it("rejects reports with a stale lease token (duplicate execution after lease loss)", async () => {
    const o = await project();
    const j = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke" })).json.job;
    const a = await new FakeWorker(s.base).register("slow");
    const b = await new FakeWorker(s.base).register("fast");
    const first = await a.claim();
    expect(first.task.kind).toBe("build");
    // worker A stalls: its lease expires and the reaper re-queues the build
    await waitFor(async () => (await s.db.query("SELECT state FROM tasks WHERE id = $1", [first.task.id])).rows[0].state === "QUEUED", 10_000, "re-queue");
    const second = await b.claim();
    expect(second.task.id).toBe(first.task.id);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    // the stale worker wakes up and reports: rejected, nothing applied
    const stale = await a.complete(first.task.id, first.leaseToken, { state: "FAILED", durationMs: 1 });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("LEASE_LOST");
    expect((await a.heartbeat(first.task.id, first.leaseToken)).status).toBe(409);
    const m = await b.upload(second.task.id, second.leaseToken, "model", "sim", Buffer.from("x"));
    expect((await b.complete(second.task.id, second.leaseToken, { state: "PASSED", durationMs: 1, modelArtifactId: m.json.id })).status).toBe(200);
    await b.drain();
    const done = await job(o.c, j.id);
    expect(done.state).toBe("SUCCEEDED");
    const attempts = (await s.db.query("SELECT attempt FROM tasks WHERE id = $1", [first.task.id])).rows[0].attempt;
    expect(attempts).toBe(2);
    expect(s.app.ctx.metrics.staleReports.get()).toBeGreaterThan(0);
  });

  it("recovers from a crashed worker and gives up after max attempts", async () => {
    const o = await project();
    const j = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke" })).json.job;
    const w = await new FakeWorker(s.base).register("crashy");
    for (let i = 0; i < 3; i++) {
      const c = await waitFor(() => w.claim(), 15_000, `claim ${i}`);
      expect(c.task.kind).toBe("build");
      // crash: never report, never heartbeat
    }
    await waitFor(async () => (await job(o.c, j.id)).state === "FAILED", 15_000, "job failed after 3 lost workers");
    const t = (await s.db.query("SELECT state, attempt, error FROM tasks WHERE job_id = $1 AND kind = 'build'", [j.id])).rows[0];
    expect(t).toMatchObject({ state: "ERROR", attempt: 3 });
    expect(t.error).toMatch(/worker lost 3 time/);
    const skipped = (await s.db.query("SELECT count(*)::int AS n FROM tasks WHERE job_id = $1 AND state = 'SKIPPED'", [j.id])).rows[0].n;
    expect(skipped).toBe(4);
  });

  it("retries infrastructure errors on another worker but not test failures", async () => {
    const o = await project();
    const j = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke", tests: ["t1"] })).json.job;
    const w = await new FakeWorker(s.base).register();
    const b = await w.claim();
    expect((await w.complete(b.task.id, b.leaseToken, { state: "ERROR", retryable: true, error: "docker daemon unavailable", durationMs: 1 })).json.requeued).toBe(true);
    await w.drain((t) => (t.testName === "t1" ? "FAILED" : "PASSED"));
    const d = await job(o.c, j.id);
    expect(d.state).toBe("FAILED");
    expect(d.summary).toMatchObject({ tests: 1, failed: 1 });
  });

  it("reports partial regression failures precisely", async () => {
    const o = await project();
    const j = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke" })).json.job;
    await (await new FakeWorker(s.base).register()).drain((t) => (t.testName === "t2" && t.seed === 2 ? "FAILED" : "PASSED"));
    const d = await job(o.c, j.id);
    expect(d.state).toBe("FAILED");
    expect(d.summary).toMatchObject({ tests: 4, passed: 3, failed: 1 });
    const failing = (await o.c.get(`/api/v1/jobs/${j.id}/tasks?state=failing`)).json.tasks;
    expect(failing.map((t: any) => `${t.test_name}:${t.seed}`)).toEqual(["t2:2"]);
  });

  it("re-runs a failing test as configured and marks it flaky when it then passes", async () => {
    const o = await orgWithProject(s.base);
    await uploadSnapshot(o.c, o.project.id, snapshotOf({ ...files, "verifycloud.yaml": minimalConfig().replace("t1: {}", "t1: { retries: 1 }") }));
    const j = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke", tests: ["t1"] })).json.job;
    let n = 0;
    await (await new FakeWorker(s.base).register()).drain(() => (n++ === 0 ? "FAILED" : "PASSED"));
    const d = await job(o.c, j.id);
    expect(d.state).toBe("SUCCEEDED");
    expect(d.summary.flaky).toBe(1);
  });

  it("skips tests when the build fails", async () => {
    const o = await project();
    const j = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke" })).json.job;
    const w = await new FakeWorker(s.base).register();
    const b = await w.claim();
    await w.complete(b.task.id, b.leaseToken, { state: "FAILED", durationMs: 1, error: "rtl/a.sv:3: syntax error", result: { summary: "syntax error" } });
    const d = await job(o.c, j.id);
    expect(d.state).toBe("FAILED");
    expect(d.error).toMatch(/build failed/);
    expect(await w.claim()).toBeNull();
  });
});

describe("cancellation and timeouts", () => {
  it("cancels queued tasks immediately and signals running ones through the heartbeat", async () => {
    const o = await project();
    const j = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke" })).json.job;
    const w = await new FakeWorker(s.base).register();
    const b = await w.claim();
    const r = await o.c.post(`/api/v1/jobs/${j.id}/cancel`);
    expect(r.status).toBe(200);
    expect((await w.heartbeat(b.task.id, b.leaseToken)).json.cancel).toBe(true);
    await w.complete(b.task.id, b.leaseToken, { state: "CANCELLED", durationMs: 1 });
    const d = await job(o.c, j.id);
    expect(d.state).toBe("CANCELLED");
    expect(await w.claim()).toBeNull();
  });

  it("times out a job that exceeds its plan's maximum duration", async () => {
    const o = await project();
    const j = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke" })).json.job;
    await s.db.query("UPDATE jobs SET deadline_at = now() - interval '1 second' WHERE id = $1", [j.id]);
    await waitFor(async () => (await job(o.c, j.id)).state === "TIMED_OUT", 10_000, "timeout");
  });
});

describe("fairness and quotas", () => {
  it("serves the organization using the smallest share of its quota first", async () => {
    const a = await project();
    const b = await project();
    // org A queues three jobs first, org B one job afterwards
    for (let i = 0; i < 3; i++) await a.c.post(`/api/v1/projects/${a.project.id}/jobs`, { regression: "smoke" });
    await sleep(20);
    await b.c.post(`/api/v1/projects/${b.project.id}/jobs`, { regression: "smoke" });
    const w = await new FakeWorker(s.base).register();
    const first = await w.claim();
    const second = await w.claim();
    // A's first build, then B's build (B has 0 running < A's 1) before A's next jobs
    const orgOf = async (taskId: string) => (await s.db.query("SELECT org_id FROM tasks WHERE id = $1", [taskId])).rows[0].org_id;
    expect(await orgOf(first.task.id)).toBe(a.org.id);
    expect(await orgOf(second.task.id)).toBe(b.org.id);
  });

  it("enforces the organization's concurrent task quota", async () => {
    const o = await project();
    await s.db.query("UPDATE plans SET max_concurrent_tasks = 2 WHERE name = 'free'");
    try {
      const j = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke" })).json.job;
      const w = await new FakeWorker(s.base).register();
      const b = await w.claim();
      const m = await w.upload(b.task.id, b.leaseToken, "model", "sim", Buffer.from("x"));
      await w.complete(b.task.id, b.leaseToken, { state: "PASSED", durationMs: 1, modelArtifactId: m.json.id });
      const held = [];
      for (let i = 0; i < 4; i++) {
        const c = await w.claim();
        if (c && (await s.db.query("SELECT job_id FROM tasks WHERE id = $1", [c.task.id])).rows[0].job_id === j.id) held.push(c);
      }
      const running = (await s.db.query("SELECT count(*)::int AS n FROM tasks WHERE org_id = $1 AND state = 'RUNNING'", [o.org.id])).rows[0].n;
      expect(running).toBeLessThanOrEqual(2);
      for (const c of held) await w.complete(c.task.id, c.leaseToken, { state: "PASSED", durationMs: 1 });
    } finally {
      await s.db.query("UPDATE plans SET max_concurrent_tasks = 4 WHERE name = 'free'");
    }
  });

  it("refuses regressions larger than the plan allows", async () => {
    const o = await orgWithProject(s.base);
    await uploadSnapshot(o.c, o.project.id, snapshotOf({ ...files, "verifycloud.yaml": minimalConfig().replace("seeds: [1, 2, 3]", "seeds: { range: [1, 300] }") }));
    const r = await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke" });
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe("QUOTA_EXCEEDED");
  });
});

describe("reproducibility", () => {
  it("re-run creates a new job from the exact recorded source and configuration", async () => {
    const o = await project();
    const j = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke" })).json.job;
    // a newer snapshot must not affect the re-run
    await uploadSnapshot(o.c, o.project.id, snapshotOf({ ...files, "verifycloud.yaml": minimalConfig().replace("t2: { seeds: [1, 2, 3] }", "t2: { seeds: [9] }") }));
    const r = await o.c.post(`/api/v1/jobs/${j.id}/rerun`, {});
    expect(r.status).toBe(201);
    const orig = (await s.db.query("SELECT source, config, config_sha256 FROM jobs WHERE id = $1", [j.id])).rows[0];
    const rerun = (await s.db.query("SELECT source, config, parent_job_id, trigger FROM jobs WHERE id = $1", [r.json.job.id])).rows[0];
    expect(rerun.source.snapshotId).toBe(orig.source.snapshotId);
    expect(rerun.config).toEqual(orig.config);
    expect(rerun).toMatchObject({ parent_job_id: j.id, trigger: "rerun" });
    const seeds = (await s.db.query("SELECT seed FROM tasks WHERE job_id = $1 AND test_name = 't2' ORDER BY seed", [r.json.job.id])).rows.map((x) => Number(x.seed));
    expect(seeds).toEqual([1, 2, 3]);
  });
});
