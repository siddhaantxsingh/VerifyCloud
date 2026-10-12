// Sandboxes for untrusted simulation workloads (docs/worker-security.md).
//
// DockerSandbox (production): one container per build/test run with
//   --network none, --read-only root fs, --cap-drop ALL, no-new-privileges,
//   Docker's default seccomp profile, an unprivileged uid, PID limit, memory
//   limit (swap disabled), CPU quota, size-limited tmpfs for scratch space,
//   the sources mounted read-only, and one writable output directory whose
//   size is monitored. Output volume, wall time and output-directory size are
//   enforced by the worker, which kills the container on violation.
// ProcessSandbox (development only): plain process with ulimits; NO network
//   or filesystem isolation. Refused unless ALLOW_UNSAFE_PROCESS_SANDBOX=true,
//   and the API refuses such workers in public demo mode.
import { execFile, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { boundedDirUsage } from "./safefs.js";

export interface Mount {
  host: string;
  container: string;
  readOnly: boolean;
}

export interface RunSpec {
  command: string[];          // argv inside the sandbox
  mounts: Mount[];
  outDir: Mount;              // writable output directory (monitored)
  workdir: string;
  cpu: number;
  memoryMb: number;
  diskMb: number;             // size of the scratch space (/work/scratch and /tmp)
  scratchHost: string;        // host directory used as scratch by the process sandbox
  timeoutMs: number;
  maxLogBytes: number;
  hardOutputBytes: number;
  maxOutDirBytes: number;
  pids: number;
  env?: Record<string, string>;
  shouldCancel?: () => boolean;
}

export interface RunResult {
  exitCode: number | null;
  timedOut: boolean;
  oomKilled: boolean;
  outputExceeded: boolean;
  diskExceeded: boolean;
  cancelled: boolean;
  log: string;
  droppedBytes: number;
  durationMs: number;
  cpuSeconds: number | null;  // from the container's cgroup, sampled; null when unavailable
  infraError: string | null;  // the sandbox itself failed (not the workload)
}

export interface Sandbox {
  /** Remove sandboxes left behind by a previous run of this worker (crash, SIGKILL, drain timeout). */
  cleanupOrphans?(): number;
  readonly name: "docker" | "process";
  run(spec: RunSpec): Promise<RunResult>;
  describe(): Record<string, unknown>;
}

/** Run a docker CLI command without blocking the event loop (lease heartbeats
 *  must keep flowing while the daemon tears down a misbehaving container). */
function docker(args: string[], timeoutMs = 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const c = (err as { code?: unknown } | null)?.code;
      resolve({ code: err ? (typeof c === "number" ? c : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** Output-directory usage check: bounded work, no symlink following (see safefs.ts). */
function outDirExceeded(p: string, maxBytes: number): boolean {
  const u = boundedDirUsage(p, { maxEntries: 10_000, maxDepth: 32 });
  return u.exceeded !== null || u.bytes > maxBytes;
}

/**
 * Keeps the first maxKeep bytes and the last TAIL bytes of a run's output.
 * The tail matters: the harness prints its verdict (VC_SIM_END) last, so a
 * passing run with a long log must not be misread as unfinished (audit M7).
 * NUL bytes are replaced: PostgreSQL rejects them in text/jsonb, which used to
 * turn a run's completion into a retry loop (audit M8).
 */
const TAIL = 64 * 1024;
export class OutputCollector {
  private chunks: Buffer[] = [];
  private tail: Buffer = Buffer.alloc(0);
  kept = 0;
  total = 0;
  constructor(private maxKeep: number) {}
  push(b: Buffer, _stream: "out" | "err") {
    this.total += b.length;
    if (this.kept < this.maxKeep) {
      const room = this.maxKeep - this.kept;
      const part = b.length > room ? b.subarray(0, room) : b;
      this.chunks.push(part);
      this.kept += part.length;
      b = b.subarray(part.length);
    }
    if (b.length) this.tail = Buffer.concat([this.tail, b]).subarray(-TAIL);
  }
  text() {
    const head = Buffer.concat(this.chunks).toString("utf8");
    const out = this.dropped > 0 ? `${head}\n[verifycloud] … ${this.dropped} bytes of output omitted …\n${this.tail.toString("utf8")}` : `${head}${this.tail.toString("utf8")}`;
    return out.replace(/\u0000/g, "\uFFFD");
  }
  get dropped() {
    return this.total - this.kept - this.tail.length;
  }
}

function cgroupCpuSeconds(containerId: string): number | null {
  for (const p of [`/sys/fs/cgroup/system.slice/docker-${containerId}.scope/cpu.stat`, `/sys/fs/cgroup/docker/${containerId}/cpu.stat`]) {
    try {
      const m = /usage_usec (\d+)/.exec(readFileSync(p, "utf8"));
      if (m) return Number(m[1]) / 1e6;
    } catch {
      /* not available */
    }
  }
  return null;
}

export class DockerSandbox implements Sandbox {
  readonly name = "docker" as const;
  /** runtime: optional OCI runtime for stronger isolation, e.g. "runsc" (gVisor). */
  constructor(private image: string, private runtime?: string, private owner = "default") {}

  /** Containers are labelled with their owner; a restarted worker removes its leftovers. */
  cleanupOrphans(): number {
    const r = spawnSync("docker", ["ps", "-aq", "--filter", `label=vc.owner=${this.owner}`], { encoding: "utf8", timeout: 30_000 });
    const ids = (r.stdout ?? "").split("\n").filter(Boolean);
    if (ids.length) spawnSync("docker", ["rm", "-f", ...ids], { timeout: 60_000 });
    return ids.length;
  }

  describe() {
    const r = spawnSync("docker", ["image", "inspect", "-f", "{{.Id}}", this.image], { encoding: "utf8" });
    const digest = r.status === 0 ? r.stdout.trim() : null;
    const tc = spawnSync("docker", ["run", "--rm", "--network", "none", this.image, "cat", "/opt/verifycloud/toolchain.txt"], { encoding: "utf8", timeout: 60_000 });
    const toolchain = Object.fromEntries(
      (tc.stdout ?? "")
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    return { sandbox: "docker", image: this.image, imageDigest: digest, runtime: this.runtime ?? "default", ...toolchain };
  }

  async run(spec: RunSpec): Promise<RunResult> {
    const name = `vc-${randomBytes(8).toString("hex")}`;
    const args = [
      "create", "--name", name,
      "--label", "vc.sandbox=1", "--label", `vc.owner=${this.owner}`,
      // a minimal init as PID 1: reaps zombies (fork bombs, $system children)
      // and forwards signals, so the simulator never runs with PID-1 semantics
      "--init",
      ...(this.runtime ? ["--runtime", this.runtime] : []),
      "--network", "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(spec.pids),
      "--memory", `${spec.memoryMb}m`, "--memory-swap", `${spec.memoryMb}m`,
      "--cpus", String(spec.cpu),
      "--user", "10001:10001",
      "--ulimit", "core=0",
      "--ulimit", `nofile=4096:4096`,
      // no single file larger than the output budget (bounds writes between monitor samples)
      "--ulimit", `fsize=${spec.maxOutDirBytes}:${spec.maxOutDirBytes}`,
      "--tmpfs", `/tmp:rw,noexec,nosuid,size=64m,uid=10001,gid=10001`,
      "--tmpfs", `/work/scratch:rw,exec,nosuid,size=${spec.diskMb}m,uid=10001,gid=10001`,
      "--workdir", spec.workdir,
      "--log-driver", "none",
      "--stop-timeout", "1",
    ];
    for (const m of [...spec.mounts, spec.outDir]) args.push("--mount", `type=bind,src=${m.host},dst=${m.container}${m.readOnly ? ",readonly" : ""}`);
    for (const [k, v] of Object.entries(spec.env ?? {})) args.push("--env", `${k}=${v}`);
    args.push(this.image, ...spec.command);
    const created = spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 });
    if (created.status !== 0)
      return { exitCode: null, timedOut: false, oomKilled: false, outputExceeded: false, diskExceeded: false, cancelled: false, log: "", droppedBytes: 0, durationMs: 0, cpuSeconds: null, infraError: `docker create failed: ${(created.stderr || "").slice(0, 500)}` };
    const id = created.stdout.trim();
    const out = new OutputCollector(spec.maxLogBytes);
    const t0 = Date.now();
    let timedOut = false;
    let outputExceeded = false;
    let diskExceeded = false;
    let cancelled = false;
    let cpu: number | null = null;
    let killing: Promise<unknown> | null = null;
    const kill = () => (killing ??= docker(["kill", name], 30_000));
    const result = await new Promise<number | null>((resolve) => {
      const p = spawn("docker", ["start", "-a", name], { stdio: ["ignore", "pipe", "pipe"] });
      const onData = (stream: "out" | "err") => (b: Buffer) => {
        if (outputExceeded) return;
        out.push(b, stream);
        if (out.total > spec.hardOutputBytes) {
          outputExceeded = true;
          void kill();
          // stop consuming the flood: detach the client instead of draining it
          p.stdout.destroy();
          p.stderr.destroy();
          p.kill("SIGKILL");
        }
      };
      p.stdout.on("data", onData("out"));
      p.stderr.on("data", onData("err"));
      const timer = setTimeout(() => {
        timedOut = true;
        void kill();
      }, spec.timeoutMs);
      const monitor = setInterval(() => {
        cpu = cgroupCpuSeconds(id) ?? cpu;
        if (!diskExceeded && outDirExceeded(spec.outDir.host, spec.maxOutDirBytes)) {
          diskExceeded = true;
          void kill();
        }
        if (!cancelled && spec.shouldCancel?.()) {
          cancelled = true;
          void kill();
        }
      }, 1000);
      p.on("close", (code) => {
        clearTimeout(timer);
        clearInterval(monitor);
        resolve(code);
      });
      p.on("error", () => resolve(null));
    });
    if (killing) await killing;
    // the attach client may have been detached: wait for the container itself
    await docker(["wait", name], 60_000);
    const insp = await docker(["inspect", "-f", "{{.State.ExitCode}} {{.State.OOMKilled}}", name]);
    const [exitStr, oomStr] = insp.stdout.trim().split(" ");
    await docker(["rm", "-f", name], 60_000);
    const exitCode = exitStr !== undefined && exitStr !== "" ? Number(exitStr) : result;
    return {
      exitCode,
      timedOut,
      // Docker's OOMKilled flag (set from the cgroup oom_kill event). A bare exit
      // code 137 is NOT treated as OOM: code inside the sandbox can SIGKILL itself.
      oomKilled: oomStr === "true",
      outputExceeded,
      diskExceeded,
      cancelled,
      log: out.text(),
      droppedBytes: out.dropped,
      durationMs: Date.now() - t0,
      cpuSeconds: cpu,
      infraError: null,
    };
  }
}

/** Development-only sandbox: ulimits and a timeout, no isolation. */
export class ProcessSandbox implements Sandbox {
  readonly name = "process" as const;
  constructor(private harnessDir: string) {}
  describe() {
    const v = spawnSync("verilator", ["--version"], { encoding: "utf8" });
    const g = spawnSync("g++", ["-dumpfullversion"], { encoding: "utf8" });
    return { sandbox: "process", verilator: v.stdout?.trim() ?? null, gcc: g.stdout?.trim() ?? null, warning: "no isolation: development only" };
  }
  async run(spec: RunSpec): Promise<RunResult> {
    // container paths are mapped to host paths
    const map = (s: string) =>
      [...spec.mounts, spec.outDir, { container: "/work/scratch", host: spec.scratchHost, readOnly: false }]
        .reduce((acc, m) => acc.split(m.container).join(m.host), s)
        .split("/opt/verifycloud/harness")
        .join(this.harnessDir);
    const argv = spec.command.map(map);
    const out = new OutputCollector(spec.maxLogBytes);
    const t0 = Date.now();
    let timedOut = false;
    let outputExceeded = false;
    let diskExceeded = false;
    let cancelled = false;
    const quoted = argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
    const script = `ulimit -v ${spec.memoryMb * 1024} 2>/dev/null; ulimit -u ${spec.pids * 4} 2>/dev/null; ulimit -c 0; exec ${quoted}`;
    const p = spawn("sh", ["-c", script], { cwd: map(spec.workdir), detached: true, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: spec.scratchHost, TMPDIR: spec.scratchHost, ...spec.env } });
    const killGroup = () => {
      try {
        process.kill(-p.pid!, "SIGKILL");
      } catch {
        /* exited */
      }
    };
    const code = await new Promise<number | null>((resolve) => {
      p.stdout.on("data", (b: Buffer) => {
        out.push(b, "out");
        if (out.total > spec.hardOutputBytes && !outputExceeded) {
          outputExceeded = true;
          killGroup();
        }
      });
      p.stderr.on("data", (b: Buffer) => out.push(b, "err"));
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, spec.timeoutMs);
      const mon = setInterval(() => {
        if (!diskExceeded && outDirExceeded(spec.outDir.host, spec.maxOutDirBytes)) {
          diskExceeded = true;
          killGroup();
        }
        if (!cancelled && spec.shouldCancel?.()) {
          cancelled = true;
          killGroup();
        }
      }, 1000);
      p.on("close", (c, sig) => {
        clearTimeout(timer);
        clearInterval(mon);
        resolve(c ?? (sig ? 128 + 9 : null));
      });
    });
    return { exitCode: code, timedOut, oomKilled: false, outputExceeded, diskExceeded, cancelled, log: out.text(), droppedBytes: out.dropped, durationMs: Date.now() - t0, cpuSeconds: null, infraError: null };
  }
}

export function createSandbox(kind: "docker" | "process", image: string, allowUnsafe: boolean, harnessDir: string, owner = "default"): Sandbox {
  if (kind === "docker") {
    const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error("docker is not available; the docker sandbox is required (see docs/worker-security.md)");
    const runtime = process.env.SANDBOX_RUNTIME || undefined;
    if (runtime && !/^[a-z0-9._-]{1,40}$/i.test(runtime)) throw new Error("invalid SANDBOX_RUNTIME");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(owner)) throw new Error("invalid worker name (used as the sandbox owner label)");
    return new DockerSandbox(image, runtime, owner);
  }
  if (!allowUnsafe) throw new Error("the process sandbox provides no isolation; set ALLOW_UNSAFE_PROCESS_SANDBOX=true to use it for local development only");
  if (!existsSync(join(harnessDir, "vc_main.cpp"))) throw new Error(`harness not found in ${harnessDir}`);
  return new ProcessSandbox(harnessDir);
}
