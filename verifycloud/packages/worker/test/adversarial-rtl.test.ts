// Adversarial RTL regressions (audit 2026-10-14), run against the real Docker
// sandbox and real Verilator, like sandbox.test.ts. Each design below is what a
// hostile or broken user could submit:
//   - $fopen / `include of host paths (secrets on the worker host),
//   - writes that try to land outside the run directory,
//   - DPI-C imports bound straight to libc (system, unshare, getenv): no C file
//     needed, Verilator links them,
//   - an elaboration-time infinite loop and a design too large to compile,
//   - an output-file flood spread over many files (host disk).
// The worker must contain each one, report a sensible state, leave no
// containers behind, and keep serving the next job.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, orgWithProject, snapshotOf, startServer, uploadSnapshot, waitFor, type TestServer } from "../../server/test/helpers.js";
import { startWorker } from "../src/main.js";

const IMAGE = process.env.SIM_IMAGE ?? "verifycloud-sim:verilator";
const dockerOk = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;
const d = dockerOk ? describe : describe.skip;

const OUT_LIMIT = 16 * 1024 * 1024;
const WORK = join(process.env.TMPDIR ?? "/tmp", `vc-adv-${process.pid}`);
const NAME = `adv-${randomBytes(3).toString("hex")}`;
const SECRET = `VC_HOST_SECRET_${randomBytes(8).toString("hex")}`;
const CANARY = join(process.env.TMPDIR ?? "/tmp", `vc-canary-${randomBytes(4).toString("hex")}.txt`);
const WORK_CANARY = join(WORK, "worker-secret.txt");

let db: { url: string; drop: () => Promise<void> };
let s: TestServer;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  if (!dockerOk) return;
  mkdirSync(WORK, { recursive: true });
  writeFileSync(CANARY, `${SECRET}\n`, { mode: 0o644 });
  writeFileSync(WORK_CANARY, `${SECRET}\n`, { mode: 0o644 });
  db = await createTestDatabase();
  s = await startServer(db.url);
  worker = await startWorker({
    apiUrl: s.base,
    name: NAME,
    sandbox: "docker",
    simImage: IMAGE,
    cpus: 4,
    memoryMb: 4096,
    pollIntervalMs: 200,
    workDir: WORK,
    limits: { maxLogBytes: 256 * 1024, hardOutputBytes: 4 * 1024 * 1024, maxOutDirBytes: OUT_LIMIT, maxWaveformBytes: 8 * 1024 * 1024, maxRepoBytes: 64 * 1024 * 1024, pids: 256, gitTimeoutMs: 30_000 },
  });
}, 120_000);

afterAll(async () => {
  if (!dockerOk) return;
  await worker?.stop();
  await s?.app.close();
  await db?.drop();
  rmSync(CANARY, { force: true });
  rmSync(WORK, { recursive: true, force: true });
});

const cfg = (tests: string, resources = "") => `version: 1
project: { name: adversarial }
rtl: { sources: ["rtl/*.sv"] }
testbench: { sources: ["tb/*.sv"], top: tb }
simulator: { engine: verilator, timing: true }
tests:
${tests}
regressions:
  default: { tests: [t] }
${resources}`;
const RTL = "module dut(input logic a, output logic y); assign y = ~a; endmodule\n";
const leftovers = () => spawnSync("docker", ["ps", "-aq", "--filter", `label=vc.owner=${NAME}`], { encoding: "utf8" }).stdout.trim();

async function run(files: Record<string, string>, timeoutMs = 600_000) {
  const o = await orgWithProject(s.base, "adv");
  await uploadSnapshot(o.c, o.project.id, snapshotOf(files));
  const t0 = Date.now();
  const r = await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "default" });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.job.id as string;
  const job = await waitFor(async () => {
    const j = (await o.c.get(`/api/v1/jobs/${id}`)).json.job;
    return ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "RESOURCE_EXCEEDED", "ERROR"].includes(j.state) ? j : null;
  }, timeoutMs, `job ${id}`);
  const list = (await o.c.get(`/api/v1/jobs/${id}/tasks`)).json.tasks as any[];
  const tasks = await Promise.all(list.map(async (t) => ({ ...(await o.c.get(`/api/v1/tasks/${t.id}`)).json.task, test_name: t.test_name })));
  const logOf = async (t: any) => {
    const lines = ((await o.c.get(`/api/v1/tasks/${t.id}/log?limit=2000`)).json?.lines ?? []) as { text: string }[];
    return lines.map((l) => l.text).join("\n") + "\n" + (t.error ?? "");
  };
  return { job, tasks, build: tasks.find((t) => t.kind === "build"), test: tasks.find((t) => t.kind === "test"), logOf, seconds: (Date.now() - t0) / 1000 };
}

async function stillServes() {
  await waitFor(async () => leftovers() === "", 30_000, "sandbox containers removed");
  const next = await run({ "verifycloud.yaml": cfg("  t: {}"), "rtl/dut.sv": RTL, "tb/tb.sv": "module tb; initial $finish; endmodule\n" });
  expect(next.job.state).toBe("SUCCEEDED");
}

d("adversarial RTL against the sandbox", () => {
  it("$fopen of host files and of the worker's directory sees nothing; writes outside the run directory do not reach the host", async () => {
    const escape = `/tmp/vc-escape-${randomBytes(4).toString("hex")}`;
    const tryRead = (p: string, tag: string) => `
      fd = $fopen("${p}", "r");
      if (fd == 0) $display("${tag}_NOFILE"); else begin void'($fgets(line, fd)); $display("${tag}=%s", line); $fclose(fd); end`;
    const tb = `module tb; integer fd; string line; initial begin
      ${tryRead(CANARY, "VC_HOST_CANARY")}
      ${tryRead(WORK_CANARY, "VC_WORK_CANARY")}
      ${tryRead("/work/out/../../../" + CANARY, "VC_DOTDOT_CANARY")}
      ${tryRead("/proc/1/environ", "VC_PID1_ENV")}
      fd = $fopen("/work/out/../../..${escape}", "w"); if (fd != 0) begin $fwrite(fd, "x"); $fclose(fd); end
      fd = $fopen("${escape}", "w"); if (fd != 0) begin $fwrite(fd, "x"); $fclose(fd); end
      fd = $fopen("/work/src/pwn.sv", "w"); if (fd == 0) $display("VC_SRC_RO"); else $display("VC_SRC_WRITABLE");
      $finish;
    end endmodule\n`;
    const r = await run({ "verifycloud.yaml": cfg("  t: {}"), "rtl/dut.sv": RTL, "tb/tb.sv": tb });
    const log = await r.logOf(r.test);
    expect(log).toContain("VC_HOST_CANARY_NOFILE");
    expect(log).toContain("VC_WORK_CANARY_NOFILE");
    expect(log).toContain("VC_DOTDOT_CANARY_NOFILE");
    expect(log).toContain("VC_SRC_RO");
    expect(log).not.toContain(SECRET);
    expect(existsSync(escape), `${escape} must not exist on the host`).toBe(false);
    await stillServes();
  }, 1_200_000);

  it("`include of an absolute host path fails to compile and never shows the file's contents", async () => {
    const rtl = `\`include "${CANARY}"\nmodule dut(input logic a, output logic y); assign y = ~a; endmodule\n`;
    const r = await run({ "verifycloud.yaml": cfg("  t: {}"), "rtl/dut.sv": rtl, "tb/tb.sv": "module tb; initial $finish; endmodule\n" });
    expect(r.build.state).toBe("FAILED");
    const log = await r.logOf(r.build);
    expect(log).not.toContain(SECRET);
    expect(r.job.state).toBe("FAILED");
  }, 1_200_000);

  it("DPI-C imports bound to libc (system, getenv, unshare) run only inside the sandbox", async () => {
    const tb = `module tb;
      import "DPI-C" function int system(input string cmd);
      import "DPI-C" function int unshare(input int flags);
      import "DPI-C" function int setuid(input int unsigned uid);
      initial begin
        void'(system("echo VC_DPI_SYSTEM_RAN; echo VC_DPI_UID=$(id -u)"));
        void'(system("test -e /var/run/docker.sock && echo VC_DPI_SOCK || echo VC_DPI_NOSOCK"));
        void'(system("(exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null && echo VC_DPI_NET_OPEN || echo VC_DPI_NET_BLOCKED"));
        void'(system("cat ${CANARY} 2>/dev/null || echo VC_DPI_NO_CANARY"));
        $display("VC_DPI_UNSHARE_USER=%0d", unshare(32'h10000000));
        $display("VC_DPI_UNSHARE_MOUNT=%0d", unshare(32'h00020000));
        $display("VC_DPI_SETUID0=%0d", setuid(0));
        $finish;
      end
    endmodule\n`;
    const r = await run({ "verifycloud.yaml": cfg("  t: {}"), "rtl/dut.sv": RTL, "tb/tb.sv": tb });
    const log = await r.logOf(r.test);
    expect(log, log).toContain("VC_DPI_SYSTEM_RAN");
    expect(log).toContain("VC_DPI_UID=10001");
    expect(log).toContain("VC_DPI_NOSOCK");
    expect(log).toContain("VC_DPI_NET_BLOCKED");
    expect(log).toContain("VC_DPI_NO_CANARY");
    expect(log).toContain("VC_DPI_UNSHARE_USER=-1");
    expect(log).toContain("VC_DPI_UNSHARE_MOUNT=-1");
    expect(log).toContain("VC_DPI_SETUID0=-1");
    expect(log).not.toContain(SECRET);
    await stillServes();
  }, 1_200_000);

  it("an elaboration-time infinite loop is stopped by Verilator or the compile time limit", async () => {
    const rtl = `module dut(input logic a, output logic y);
      function automatic int spin(); int i = 0; while (1) i = i + 1; return i; endfunction
      localparam int P = spin();
      assign y = a ^ P[0];
    endmodule\n`;
    const r = await run({ "verifycloud.yaml": cfg("  t: {}", "resources: { compile_timeout_seconds: 60 }"), "rtl/dut.sv": rtl, "tb/tb.sv": "module tb; logic a, y; dut u(.a(a), .y(y)); initial $finish; endmodule\n" });
    expect(["FAILED", "TIMED_OUT", "RESOURCE_EXCEEDED"]).toContain(r.build.state);
    expect(r.job.state).not.toBe("SUCCEEDED");
    expect(r.build.attempt, "a user's design is not retried as an infrastructure error").toBe(1);
    await stillServes();
  }, 1_200_000);

  it("a design too large to compile hits the compile time or memory limit, not the host", async () => {
    const rtl = `module dut(input logic clk, input logic a, output logic y);
      logic [255:0] r [0:399999];
      for (genvar i = 0; i < 400000; i++) begin : g
        always_ff @(posedge clk) r[i] <= {r[i][254:0], a ^ r[(i + 7) % 400000][i % 256]};
      end
      assign y = r[0][0];
    endmodule\n`;
    const r = await run({
      "verifycloud.yaml": cfg("  t: {}", "resources: { compile_timeout_seconds: 60, compile_memory_mb: 768 }"),
      "rtl/dut.sv": rtl,
      "tb/tb.sv": "module tb; logic clk = 0, a = 0, y; dut u(.clk(clk), .a(a), .y(y)); initial $finish; endmodule\n",
    });
    expect(["TIMED_OUT", "RESOURCE_EXCEEDED", "FAILED"]).toContain(r.build.state);
    expect(r.build.attempt).toBe(1);
    // the build's container is bounded by the 60 s compile limit (plus scheduling)
    expect(r.seconds).toBeLessThan(400);
    await stillServes();
  }, 1_200_000);

  it("an output flood spread over many files is stopped near the output budget (host disk)", async () => {
    // 64 files × 8 MiB = 512 MiB attempted against a 16 MiB budget; each file
    // is under the per-file ulimit, so only the directory monitor stops it
    const tb = `module tb; integer fd; initial begin
      void'($system("for i in $(seq 64); do head -c 8388608 /dev/zero > /work/out/f$i || break; done; echo VC_FLOOD_DONE"));
      $finish;
    end endmodule\n`;
    let peak = 0;
    const sample = setInterval(() => {
      const dir = join(WORK, NAME);
      try {
        for (const task of readdirSync(dir)) {
          const out = join(dir, task, "out");
          if (!existsSync(out)) continue;
          let sum = 0;
          for (const f of readdirSync(out)) sum += statSync(join(out, f)).size;
          peak = Math.max(peak, sum);
        }
      } catch {
        /* directories come and go */
      }
    }, 20);
    const r = await run({ "verifycloud.yaml": cfg("  t: {}"), "rtl/dut.sv": RTL, "tb/tb.sv": tb });
    clearInterval(sample);
    // eslint-disable-next-line no-console
    console.log(`[adversarial] output flood: peak ${Math.round(peak / 1048576)} MiB on the host for a ${OUT_LIMIT / 1048576} MiB budget; state ${r.test.state}`);
    expect(r.test.state).toBe("RESOURCE_EXCEEDED");
    expect(peak, `peak host bytes ${peak}`).toBeLessThan(8 * OUT_LIMIT);
    await stillServes();
  }, 1_200_000);
});
