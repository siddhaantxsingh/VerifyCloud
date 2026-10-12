// Failure injection with the real worker and Docker sandbox: the API process
// restarts, PostgreSQL restarts, and object storage becomes unreachable while
// a simulation is running. Expected: the run completes exactly once (same
// attempt, no duplicate execution), readiness reflects the outage, and the
// event stream recovers. Skipped when Docker/the sim image is unavailable;
// the PostgreSQL test needs local control of the cluster (pg_ctlcluster).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, connect, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, orgWithProject, S3, sleep, snapshotOf, startServer, uploadSnapshot, waitFor, type TestServer } from "../../server/test/helpers.js";
import { startWorker } from "../src/main.js";

const IMAGE = process.env.SIM_IMAGE ?? "verifycloud-sim:verilator";
const dockerOk = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;
const pgCtl = spawnSync("pg_lsclusters", [], { encoding: "utf8" }).status === 0 && process.env.VC_TEST_PG_RESTART !== "false";
const d = dockerOk ? describe : describe.skip;

/** A TCP forwarder in front of the S3 endpoint that can simulate an outage. */
class Toxiproxy {
  private server!: Server;
  private socks = new Set<Socket>();
  down = false;
  port = 0;
  constructor(private target: URL) {}
  async start() {
    this.server = createServer((client) => {
      if (this.down) return client.destroy();
      const up = connect(Number(this.target.port), this.target.hostname);
      this.socks.add(client).add(up);
      const drop = () => {
        this.socks.delete(client);
        this.socks.delete(up);
        client.destroy();
        up.destroy();
      };
      client.on("error", drop).on("close", drop);
      up.on("error", drop).on("close", drop);
      client.pipe(up).pipe(client);
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
    return this;
  }
  cut() {
    this.down = true;
    for (const s of this.socks) s.destroy();
  }
  restore() {
    this.down = false;
  }
  close() {
    this.cut();
    this.server.close();
  }
}

const freePort = async () => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return p;
};

const CFG = `version: 1
project: { name: recovery }
rtl: { sources: ["rtl/*.sv"] }
testbench: { sources: ["tb/*.sv"], top: tb }
simulator: { engine: verilator, timing: true }
tests:
  t: { timeout_seconds: 120 }
regressions:
  default: { tests: [t] }
`;
// the simulation runs for SLEEP seconds of wall time (inside the sandbox)
const files = (sleepS: number) => ({
  "verifycloud.yaml": CFG,
  "rtl/dut.sv": "module dut(input logic a, output logic y); assign y = ~a; endmodule\n",
  "tb/tb.sv": `module tb; initial begin $system("sleep ${sleepS}"); $display("VC_RESULT PASS"); $finish; end endmodule\n`,
});

let db: { url: string; drop: () => Promise<void> };
let proxy: Toxiproxy;
let port: number;
let bucket: string;
let s: TestServer;
let worker: Awaited<ReturnType<typeof startWorker>>;

const boot = () =>
  startServer(db.url, { port, s3: { endpoint: `http://127.0.0.1:${proxy.port}`, region: "us-east-1", bucket, accessKeyId: "test", secretAccessKey: "test", forcePathStyle: true } } as any);

beforeAll(async () => {
  if (!dockerOk) return;
  db = await createTestDatabase();
  proxy = await new Toxiproxy(new URL(S3)).start();
  port = await freePort();
  bucket = `vc-rec-${randomBytes(4).toString("hex")}`;
  s = await boot();
  worker = await startWorker({
    apiUrl: s.base,
    name: "recovery-worker",
    sandbox: "docker",
    simImage: IMAGE,
    cpus: 2,
    memoryMb: 4096,
    pollIntervalMs: 200,
    workDir: join(process.env.TMPDIR ?? "/tmp", `vc-recovery-${process.pid}`),
  });
}, 60_000);

afterAll(async () => {
  if (!dockerOk) return;
  await worker?.stop();
  await s?.app.close();
  proxy?.close();
  await db?.drop();
});

async function startJob(sleepS: number) {
  const o = await orgWithProject(s.base, "rec");
  await uploadSnapshot(o.c, o.project.id, snapshotOf(files(sleepS)));
  const r = await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "default" });
  expect(r.status).toBe(201);
  const jobId = r.json.job.id as string;
  await waitFor(async () => (await s.db.query("SELECT 1 FROM tasks WHERE job_id = $1 AND kind = 'test' AND state = 'RUNNING'", [jobId])).rowCount, 120_000, "test task to start");
  return { o, jobId };
}

async function finished(o: { c: any }, jobId: string) {
  return waitFor(async () => {
    const r = await o.c.get(`/api/v1/jobs/${jobId}`);
    const j = r.json?.job;
    return j && !["QUEUED", "RUNNING"].includes(j.state) ? j : null;
  }, 180_000, "job to finish");
}

const testTask = async (jobId: string) => (await s.db.query("SELECT state, attempt FROM tasks WHERE job_id = $1 AND kind = 'test'", [jobId])).rows[0];

d("failure injection during a running simulation", () => {
  it("AUDIT H1: a worker marked offline after a long outage re-registers and keeps working", async () => {
    await s.db.query("UPDATE workers SET state = 'offline'");
    await waitFor(async () => (await s.db.query("SELECT 1 FROM workers WHERE name = 'recovery-worker' AND state = 'online'")).rowCount, 40_000, "re-registration");
    const { o, jobId } = await startJob(1);
    const job = await finished(o, jobId);
    expect(job.state).toBe("SUCCEEDED");
  });

  it("API restart: the worker rides it out, the result is recorded once", async () => {
    const { o, jobId } = await startJob(8);
    await s.app.close();
    await sleep(3000);
    expect(await fetch(`${s.base}/health`).then(() => "up", () => "down")).toBe("down");
    s = await boot();
    const job = await finished(o, jobId);
    expect(job.state).toBe("SUCCEEDED");
    expect(await testTask(jobId)).toMatchObject({ state: "PASSED", attempt: 1 });
  });

  it("object storage outage: readiness reports it, uploads are retried, the run completes once", async () => {
    const { o, jobId } = await startJob(4);
    proxy.cut();
    const ready = await fetch(`${s.base}/ready`);
    expect(ready.status).toBe(503);
    expect((await ready.json()).checks).toMatchObject({ database: true, objectStorage: false });
    await sleep(8000); // the simulation finishes and its uploads hit the outage
    proxy.restore();
    const job = await finished(o, jobId);
    expect(job.state).toBe("SUCCEEDED");
    expect(await testTask(jobId)).toMatchObject({ state: "PASSED", attempt: 1 });
    expect((await fetch(`${s.base}/ready`)).status).toBe(200);
    // the run's log reached storage after the outage
    const log = (await o.c.get(`/api/v1/tasks/${(await s.db.query("SELECT id FROM tasks WHERE job_id = $1 AND kind = 'test'", [jobId])).rows[0].id}/log?q=VC_RESULT`)).json;
    expect(log.total).toBeGreaterThan(0);
  });

  (pgCtl ? it : it.skip)("PostgreSQL restart: readiness reports it, the run completes once, the event stream reconnects", async () => {
    const { o, jobId } = await startJob(10);
    expect(spawnSync("pg_ctlcluster", ["16", "main", "stop", "-m", "fast"]).status).toBe(0);
    try {
      const ready = await fetch(`${s.base}/ready`);
      expect(ready.status).toBe(503);
      expect((await ready.json()).checks.database).toBe(false);
      await sleep(3000);
    } finally {
      expect(spawnSync("pg_ctlcluster", ["16", "main", "start"]).status).toBe(0);
    }
    await waitFor(async () => (await fetch(`${s.base}/ready`)).status === 200, 30_000, "API ready again");
    const job = await finished(o, jobId);
    expect(job.state).toBe("SUCCEEDED");
    expect(await testTask(jobId)).toMatchObject({ state: "PASSED", attempt: 1 });

    // LISTEN/NOTIFY re-established: a new job's completion arrives over SSE
    const ac = new AbortController();
    const res = await fetch(`${s.base}/api/v1/events?project=${o.project.id}`, { headers: { Cookie: o.c.cookie }, signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let text = "";
    const r2 = await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "default" });
    const id2 = r2.json.job.id as string;
    const t0 = Date.now();
    const got = () => text.split("\n\n").some((b) => b.includes("JOB_COMPLETED") && b.includes(id2));
    while (!got()) {
      if (Date.now() - t0 > 120_000) throw new Error("no JOB_COMPLETED over SSE");
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    ac.abort();
    expect(got()).toBe(true);
  });
});
