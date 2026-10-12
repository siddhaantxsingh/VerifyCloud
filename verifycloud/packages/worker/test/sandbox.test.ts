// Real worker + real Docker sandbox + real Verilator (image verifycloud-sim:verilator).
// These tests execute untrusted HDL exactly as production does: in a container
// with no network, a read-only root, all capabilities dropped, a non-root user,
// and CPU / memory / PID / output / time limits. Skipped when Docker or the
// simulation image is unavailable (reported as skipped, never as passed).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, DEMO_DIR, demoSnapshot, orgWithProject, snapshotOf, startServer, uploadSnapshot, waitFor, type TestServer } from "../../server/test/helpers.js";
import { startWorker } from "../src/main.js";

const IMAGE = process.env.SIM_IMAGE ?? "verifycloud-sim:verilator";
const dockerOk = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;
const d = dockerOk ? describe : describe.skip;

let db: { url: string; drop: () => Promise<void> };
let s: TestServer;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  if (!dockerOk) return;
  db = await createTestDatabase();
  s = await startServer(db.url);
  worker = await startWorker({
    apiUrl: s.base,
    name: "docker-test-worker",
    sandbox: "docker",
    simImage: IMAGE,
    cpus: 4,
    memoryMb: 4096,
    pollIntervalMs: 200,
    workDir: join(process.env.TMPDIR ?? "/tmp", `vc-worker-test-${process.pid}`),
    limits: { maxLogBytes: 256 * 1024, hardOutputBytes: 4 * 1024 * 1024, maxOutDirBytes: 256 * 1024 * 1024, maxWaveformBytes: 64 * 1024 * 1024, maxRepoBytes: 64 * 1024 * 1024, pids: 256, gitTimeoutMs: 30_000 },
  });
}, 60_000);

afterAll(async () => {
  if (!dockerOk) return;
  await worker?.stop();
  await s?.app.close();
  await db?.drop();
});

const cfg = (tests: string, resources = "") => `version: 1
project: { name: sandbox-test }
rtl: { sources: ["rtl/*.sv"] }
testbench: { sources: ["tb/*.sv"], top: tb }
simulator: { engine: verilator, timing: true }
tests:
${tests}
regressions:
  default: { tests: [t] }
${resources}`;

const RTL = "module dut(input logic a, output logic y); assign y = ~a; endmodule\n";

async function runProject(files: Record<string, string>, opts: { timeoutMs?: number; regression?: string } = {}) {
  const o = await orgWithProject(s.base, "sbx");
  await uploadSnapshot(o.c, o.project.id, snapshotOf(files));
  return runOn(o, opts);
}

async function runOn(o: Awaited<ReturnType<typeof orgWithProject>>, opts: { timeoutMs?: number; regression?: string } = {}) {
  const r = await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: opts.regression ?? "default" });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.job.id as string;
  const job = await waitFor(
    async () => {
      const j = (await o.c.get(`/api/v1/jobs/${id}`)).json.job;
      return ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "RESOURCE_EXCEEDED", "ERROR"].includes(j.state) ? j : null;
    },
    opts.timeoutMs ?? 240_000,
    `job ${id} to finish`,
  );
  const list = (await o.c.get(`/api/v1/jobs/${id}/tasks`)).json.tasks as any[];
  const tasks = await Promise.all(list.map(async (t) => ({ ...(await o.c.get(`/api/v1/tasks/${t.id}`)).json.task, test_name: t.test_name })));
  const logOf = async (t: any) => ((await o.c.get(`/api/v1/tasks/${t.id}/log?limit=2000`)).json.lines as { text: string }[]).map((l) => l.text).join("\n");
  return { o, job, tasks, logOf, test: tasks.find((t) => t.kind === "test"), build: tasks.find((t) => t.kind === "build") };
}

// sandbox containers are named vc-<16 hex>
const leftoverContainers = () =>
  spawnSync("docker", ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" }).stdout.split("\n").filter((n) => /^vc-[0-9a-f]{16}$/.test(n)).join(",");

d("Verilator in the Docker sandbox", () => {
  it("passing test; second identical run reuses the compiled model from the build cache", async () => {
    const files = { "verifycloud.yaml": cfg("  t: {}"), "rtl/dut.sv": RTL, "tb/tb.sv": `module tb; logic a, y; dut u(.a, .y); initial begin a = 0; #1; if (y !== 1) $fatal(1, "bad"); $display("VC_RESULT PASS"); $finish; end endmodule\n` };
    const o = await orgWithProject(s.base, "cache");
    await uploadSnapshot(o.c, o.project.id, snapshotOf(files));
    const a = await runOn(o);
    expect(a.job.state).toBe("SUCCEEDED");
    expect(a.build.state).toBe("PASSED");
    expect(a.build.result.cacheHit).toBeFalsy();
    expect(a.test.state).toBe("PASSED");
    const b = await runOn(o);
    expect(b.job.state).toBe("SUCCEEDED");
    expect(b.build.result.cacheHit).toBe(true);
    expect(b.build.duration_ms).toBeLessThan(a.build.duration_ms);
  });

  it("compile error: build FAILED with a file:line diagnostic, tests SKIPPED, job FAILED (not retried as infrastructure error)", async () => {
    const r = await runProject({ "verifycloud.yaml": cfg("  t: {}"), "rtl/dut.sv": "module dut(input logic a, output logic y);\n  assign y = ~a\nendmodule\n", "tb/tb.sv": "module tb; initial $finish; endmodule\n" });
    expect(r.job.state).toBe("FAILED");
    expect(r.build.state).toBe("FAILED");
    expect(r.build.attempt).toBe(1);
    expect(JSON.stringify(r.build.result.diagnostics)).toMatch(/rtl\/dut\.sv/);
    expect(r.test.state).toBe("SKIPPED");
  });

  it("simulation that never finishes is killed at its time limit: TIMED_OUT", async () => {
    const r = await runProject({ "verifycloud.yaml": cfg("  t: { timeout_seconds: 5 }"), "rtl/dut.sv": RTL, "tb/tb.sv": "module tb; initial forever #1; endmodule\n" });
    expect(r.test.state).toBe("TIMED_OUT");
    expect(r.job.state).toBe("TIMED_OUT");
    expect(r.test.error).toMatch(/time limit of 5 s/);
    expect(r.test.duration_ms).toBeLessThan(30_000);
  });

  it("memory exhaustion is stopped by the cgroup limit: RESOURCE_EXCEEDED", async () => {
    const r = await runProject({
      "verifycloud.yaml": cfg("  t: {}", "resources: { memory_mb: 512, timeout_seconds: 120 }"),
      "rtl/dut.sv": RTL,
      "tb/tb.sv": "module tb; int q[$]; initial begin forever begin for (int i = 0; i < 1000000; i++) q.push_back(i); #1; end end endmodule\n",
    });
    expect(r.build.state, await r.logOf(r.build)).toBe("PASSED");
    expect(r.test.state).toBe("RESOURCE_EXCEEDED");
    expect(r.test.error).toMatch(/memory limit of 512 MiB/);
  });

  it("output flood is cut off: run killed, log truncated, RESOURCE_EXCEEDED", async () => {
    const r = await runProject({ "verifycloud.yaml": cfg("  t: {}", "resources: { timeout_seconds: 120 }"), "rtl/dut.sv": RTL, "tb/tb.sv": `module tb; initial forever begin $display("flood flood flood flood flood flood flood flood flood flood flood flood"); #1; end endmodule\n` });
    expect(r.build.state, await r.logOf(r.build)).toBe("PASSED");
    expect(r.test.state).toBe("RESOURCE_EXCEEDED");
    expect(r.test.error).toMatch(/output flood/);
    const log = (await r.o.c.get(`/api/v1/tasks/${r.test.id}/log?limit=1`)).json;
    expect(log.truncated).toBe(true);
  });

  it("hostile testbench: no network, read-only sources and root, no capabilities, non-root, no secrets in env, no docker socket", async () => {
    const sh = (cmd: string) => `$system("bash -c '${cmd}'");`;
    const tb = `module tb; initial begin
      ${sh("(exec 3<>/dev/tcp/1.1.1.1/80) 2>/dev/null && echo VC_NET_OPEN || echo VC_NET_BLOCKED")}
      ${sh("getent hosts github.com >/dev/null 2>&1 && echo VC_DNS_OPEN || echo VC_DNS_BLOCKED")}
      ${sh("touch /work/src/pwn 2>/dev/null && echo VC_SRC_WRITABLE || echo VC_SRC_RO")}
      ${sh("touch /usr/pwn 2>/dev/null && echo VC_ROOT_WRITABLE || echo VC_ROOT_RO")}
      ${sh("echo VC_UID=$(id -u)")}
      ${sh("grep CapEff /proc/self/status | tr -d [:space:]")}
      ${sh("test -e /var/run/docker.sock && echo VC_SOCK || echo VC_NOSOCK")}
      ${sh("cp /bin/true /tmp/t 2>/dev/null; /tmp/t 2>/dev/null && echo VC_TMP_EXEC || echo VC_TMP_NOEXEC")}
      ${sh("env | grep -i -E \\\"token|secret|password|aws_|database\\\" >/dev/null && echo VC_ENV_LEAK || echo VC_ENV_CLEAN")}
      $finish;
    end endmodule\n`;
    const r = await runProject({ "verifycloud.yaml": cfg("  t: {}"), "rtl/dut.sv": RTL, "tb/tb.sv": tb });
    const log = await r.logOf(r.test);
    expect(log).toContain("VC_NET_BLOCKED");
    expect(log).toContain("VC_DNS_BLOCKED");
    expect(log).toContain("VC_SRC_RO");
    expect(log).toContain("VC_ROOT_RO");
    expect(log).toContain("VC_UID=10001");
    expect(log).toContain("CapEff:0000000000000000");
    expect(log).toContain("VC_NOSOCK");
    expect(log).toContain("VC_TMP_NOEXEC");
    expect(log).toContain("VC_ENV_CLEAN");
    expect(log).not.toMatch(/VC_(NET_OPEN|DNS_OPEN|SRC_WRITABLE|ROOT_WRITABLE|SOCK\b|TMP_EXEC|ENV_LEAK)/);
  });

  it("fork bomb is contained by the PID limit; the container is removed and the worker keeps serving", async () => {
    const tb = `module tb; initial begin
      $system("bash -c ':(){ :|:& };:' 2>/dev/null; sleep 2; bash -c 'for i in $(seq 400); do sleep 20 & done' 2>&1 | grep -m1 -E -o 'Resource temporarily unavailable|Cannot fork' || echo VC_NO_LIMIT_HIT");
      $finish;
    end endmodule\n`;
    const r = await runProject({ "verifycloud.yaml": cfg("  t: { timeout_seconds: 30 }"), "rtl/dut.sv": RTL, "tb/tb.sv": tb });
    expect(["PASSED", "TIMED_OUT", "FAILED"]).toContain(r.test.state);
    const log = await r.logOf(r.test);
    expect(log).not.toContain("VC_NO_LIMIT_HIT");
    await waitFor(async () => leftoverContainers() === "", 20_000, "sandbox containers to be removed");
    // the same worker runs the next job normally
    const next = await runProject({ "verifycloud.yaml": cfg("  t: {}"), "rtl/dut.sv": RTL, "tb/tb.sv": "module tb; initial $finish; endmodule\n" });
    expect(next.job.state).toBe("SUCCEEDED");
  });

  it("AUDIT H5: a restarted worker removes sandbox containers orphaned by its previous run", async () => {
    const orphan = spawnSync("docker", ["run", "-d", "--label", "vc.sandbox=1", "--label", "vc.owner=orphan-test-worker", IMAGE, "sleep", "600"], { encoding: "utf8" }).stdout.trim();
    expect(orphan).toMatch(/^[0-9a-f]{64}$/);
    const w2 = await startWorker({ apiUrl: s.base, name: "orphan-test-worker", sandbox: "docker", simImage: IMAGE, cpus: 1, memoryMb: 1024, pollIntervalMs: 500, workDir: join(process.env.TMPDIR ?? "/tmp", `vc-orphan-${process.pid}`) });
    await w2.stop();
    expect(spawnSync("docker", ["ps", "-aq", "--filter", `id=${orphan}`], { encoding: "utf8" }).stdout.trim()).toBe("");
  });

  it("AUDIT C1: a symlink planted in the output directory cannot make the worker read host files", async () => {
    const canary = join(process.env.TMPDIR ?? "/tmp", `vc-canary-${process.pid}-${Date.now()}`);
    const secret = `HOST-SECRET-${Math.random().toString(36).slice(2)}`;
    writeFileSync(canary, secret);
    const tb = `module tb; initial begin
      $system("rm -f /work/out/waves.vcd; ln -s ${canary} /work/out/waves.vcd; rm -f /work/out/coverage.dat; ln -s ${canary} /work/out/coverage.dat");
      $fatal(1, "fail on purpose so the waveform is collected");
    end endmodule\n`;
    const r = await runProject({ "verifycloud.yaml": cfg("  t: {}"), "rtl/dut.sv": RTL, "tb/tb.sv": tb });
    expect(r.test.state).toBe("FAILED");
    const detail = (await r.o.c.get(`/api/v1/tasks/${r.test.id}`)).json;
    for (const a of detail.artifacts.filter((x: any) => x.kind === "waveform" || x.kind === "coverage")) {
      const res = await fetch(`${s.base}/api/v1/artifacts/${a.id}/download`, { headers: { Cookie: r.o.c.cookie } });
      const body = Buffer.from(await res.arrayBuffer());
      const text = (a.encoding === "gzip" ? gunzipSync(body) : body).toString("latin1");
      expect(text).not.toContain(secret);
    }
    expect(JSON.stringify(detail.task.result.notes ?? [])).toMatch(/not a regular file/);
  });

  it("AUDIT C2: a FIFO planted in the output directory does not hang the worker", async () => {
    const tb = `module tb; initial begin
      $system("rm -f /work/out/coverage.dat /work/out/waves.vcd; mkfifo /work/out/coverage.dat /work/out/waves.vcd");
      $fatal(1, "x");
    end endmodule\n`;
    const r = await runProject({ "verifycloud.yaml": cfg("  t: { timeout_seconds: 10 }"), "rtl/dut.sv": RTL, "tb/tb.sv": tb }, { timeoutMs: 90_000 });
    expect(["FAILED", "TIMED_OUT"]).toContain(r.test.state);
    // the same worker keeps serving
    const next = await runProject({ "verifycloud.yaml": cfg("  t: {}"), "rtl/dut.sv": RTL, "tb/tb.sv": "module tb; initial $finish; endmodule\n" }, { timeoutMs: 120_000 });
    expect(next.job.state).toBe("SUCCEEDED");
  });

  it("simulator crash (SIGSEGV) is a FAILED test with the signal reported, not an infrastructure retry", async () => {
    const r = await runProject({ "verifycloud.yaml": cfg("  t: {}"), "rtl/dut.sv": RTL, "tb/tb.sv": `module tb; initial begin $system("kill -SEGV $PPID"); #10 $finish; end endmodule\n` });
    expect(r.test.state, await r.logOf(r.test)).toBe("FAILED");
    expect(r.test.attempt).toBe(1);
    expect(r.test.exit_code).toBe(139);
  });
});

d("seeded demo end to end (real Verilator)", () => {
  it("buggy AXI4-Lite: regression FAILS → evidence-backed analysis → reference fix verified in a fresh job → PASS", async () => {
    const o = await orgWithProject(s.base, "demo");
    await uploadSnapshot(o.c, o.project.id, demoSnapshot());
    const run = await runOn(o, { regression: "full", timeoutMs: 600_000 });
    expect(run.job.state).toBe("FAILED");
    const tests = run.tasks.filter((t) => t.kind === "test");
    const failed = tests.filter((t) => t.state === "FAILED");
    expect(tests.length).toBe(13);
    // only the randomized test (read back-pressure with an early next address)
    // and rw_overlap (a write lands during the R stall) expose the bug
    const exposing = ["random", "rw_overlap"];
    expect(failed.some((t) => t.test_name === "random")).toBe(true);
    expect(failed.some((t) => t.test_name === "rw_overlap")).toBe(true);
    expect(failed.every((t) => exposing.includes(t.test_name))).toBe(true);
    expect(tests.filter((t) => !exposing.includes(t.test_name)).every((t) => t.state === "PASSED")).toBe(true);

    // assertion recorded and waveform captured on failure
    const asr = (await o.c.get(`/api/v1/jobs/${run.job.id}/assertions`)).json;
    expect(JSON.stringify(asr)).toContain("rdata_stable");
    const detail = (await o.c.get(`/api/v1/tasks/${failed[0].id}`)).json;
    expect(detail.artifacts.some((a: any) => a.kind === "waveform")).toBe(true);

    // merged coverage exists and is non-trivial (actual values are measured, not asserted)
    const cov = await waitFor(async () => {
      const c = (await o.c.get(`/api/v1/jobs/${run.job.id}/coverage`)).json;
      return c.available ? c : null;
    }, 30_000, "merged coverage");
    expect(cov.summary.line.total).toBeGreaterThan(0);
    expect(cov.summary.functional.total).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`[demo-e2e] merged coverage of buggy run: ${JSON.stringify(cov.summary)}`);

    // rule-based analysis points at the bug
    const an = (await o.c.post(`/api/v1/tasks/${failed.find((t) => t.test_name === "random")!.id}/analyze`)).json.analysis;
    expect(an.status).toBe("succeeded");
    expect(an.result.locations).toEqual(expect.arrayContaining([expect.objectContaining({ file: "rtl/axil_regs.sv", line: 131, verified: true })]));

    // the reference fix (a patch, never merged) is verified in a fresh job
    const diff = readFileSync(join(DEMO_DIR, "fix-rdata-stable.patch"), "utf8");
    const p = await o.c.post(`/api/v1/jobs/${run.job.id}/patches`, { diff });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    const v = await o.c.post(`/api/v1/patches/${p.json.patch.id}/verify`);
    expect(v.status, JSON.stringify(v.json)).toBe(201);
    const vid = v.json.job.id as string;
    const fixed = await waitFor(async () => {
      const j = (await o.c.get(`/api/v1/jobs/${vid}`)).json.job;
      return ["SUCCEEDED", "FAILED", "TIMED_OUT", "RESOURCE_EXCEEDED", "CANCELLED"].includes(j.state) ? j : null;
    }, 600_000, "verification job");
    expect(fixed.state).toBe("SUCCEEDED");
    const cmp = (await o.c.get(`/api/v1/jobs/${vid}/compare?with=${run.job.id}`)).json;
    expect(cmp.newlyFailing).toEqual([]);
    expect(cmp.fixed).toHaveLength(failed.length);
    // eslint-disable-next-line no-console
    console.log(`[demo-e2e] buggy: ${failed.length}/${tests.length} failed; fixed job ${fixed.state}`);
  });
});
