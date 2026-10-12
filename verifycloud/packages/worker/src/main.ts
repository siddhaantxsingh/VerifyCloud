// Worker process: registers, claims tasks within its CPU/memory capacity,
// runs them in the sandbox, and drains gracefully on SIGTERM (running tasks
// finish; unfinished leases expire and the tasks are re-queued elsewhere).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ReregisterError, WorkerApi } from "./api.js";
import { loadWorkerConfig } from "./config.js";
import { runTask, type TaskContext } from "./runner.js";
import { createSandbox } from "./sandbox.js";

const VERSION = "0.1.0";
const log = {
  info: (msg: string, o: object = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), level: "info", msg, ...o })),
  warn: (msg: string, o: object = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), level: "warn", msg, ...o })),
};

export async function startWorker(overrides = {}) {
  const cfg = loadWorkerConfig(overrides);
  const harnessDir = process.env.HARNESS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "harness");
  const owner = cfg.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  const sandbox = createSandbox(cfg.sandbox, cfg.simImage, cfg.allowUnsafeProcessSandbox, harnessDir, owner);
  // task directories live in a per-worker subdirectory, so cleaning up after a
  // crash never touches another worker sharing the same WORK_DIR
  cfg.workDir = join(cfg.workDir, owner);
  // leftovers of a previous run of this worker: containers and task directories
  const orphans = sandbox.cleanupOrphans?.() ?? 0;
  if (orphans) log.warn("removed orphaned sandbox containers", { count: orphans });
  rmSync(cfg.workDir, { recursive: true, force: true });
  mkdirSync(cfg.workDir, { recursive: true });
  const harnessSha256 = createHash("sha256").update(readFileSync(join(harnessDir, "vc_main.cpp"))).digest("hex");
  const toolchain = { ...sandbox.describe(), harnessSha256 };
  const api = new WorkerApi(cfg);
  // the API may still be starting (or restarting): retry registration with backoff
  let reg: Awaited<ReturnType<WorkerApi["register"]>> | undefined;
  for (let attempt = 0; !reg; attempt++) {
    try {
      reg = await api.register({ sandbox: sandbox.name, toolchain, version: VERSION });
    } catch (e) {
      const msg = (e as Error).message;
      if (/HTTP 4\d\d/.test(msg)) throw e; // wrong token or refused sandbox: do not retry
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
      log.warn("registration failed; retrying", { err: msg, inMs: wait });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  log.info("worker registered", { workerId: reg.workerId, sandbox: sandbox.name, cpus: cfg.cpus, memoryMb: cfg.memoryMb, toolchain });
  const tc: TaskContext = { cfg, api, sandbox, toolchain, log };
  let usedCpu = 0;
  let usedMem = 0;
  const running = new Set<Promise<void>>();
  let draining = false;
  let stopped = false;

  // after an outage the API may have marked this worker offline: register
  // again (new identity) instead of failing every call forever (audit H1)
  let reregistering: Promise<unknown> | null = null;
  const reregister = () =>
    (reregistering ??= api
      .register({ sandbox: sandbox.name, toolchain, version: VERSION })
      .then((r) => log.warn("re-registered after being marked offline", { workerId: r.workerId }))
      .catch((e) => log.warn("re-registration failed", { err: (e as Error).message }))
      .finally(() => (reregistering = null)));
  const hb = setInterval(
    () =>
      api.heartbeatWorker(running.size, draining).catch((e) => {
        if (e instanceof ReregisterError) return reregister();
        log.warn("heartbeat failed", { err: (e as Error).message });
      }),
    10_000,
  );
  await api.heartbeatWorker(0).catch(() => {});

  const loop = async () => {
    while (!stopped) {
      if (draining) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      const free = { cpu: cfg.cpus - usedCpu, memoryMb: cfg.memoryMb - usedMem };
      let claimed = null;
      if (free.cpu >= 1 && free.memoryMb >= 256) {
        try {
          claimed = await api.claim(free);
        } catch (e) {
          if (e instanceof ReregisterError) await reregister();
          else log.warn("claim failed", { err: (e as Error).message });
        }
      }
      if (!claimed) {
        await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
        continue;
      }
      usedCpu += claimed.task.cpu;
      usedMem += claimed.task.memoryMb;
      const c = claimed;
      const p = runTask(tc, c)
        .catch((e) => log.warn("task runner failed", { task: c.task.id, err: (e as Error).message }))
        .finally(() => {
        usedCpu -= c.task.cpu;
        usedMem -= c.task.memoryMb;
        running.delete(p);
      });
      running.add(p);
    }
  };
  const loopDone = loop();
  return {
    api,
    async drain(timeoutMs = 60_000) {
      draining = true;
      await api.heartbeatWorker(running.size, true).catch(() => {});
      await Promise.race([Promise.all(running), new Promise((r) => setTimeout(r, timeoutMs))]);
    },
    async stop() {
      draining = true;
      stopped = true;
      clearInterval(hb);
      await loopDone;
    },
    runningCount: () => running.size,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const w = await startWorker();
  for (const sig of ["SIGTERM", "SIGINT"] as const)
    process.on(sig, async () => {
      log.info("draining", { signal: sig, running: w.runningCount() });
      await w.drain(Number(process.env.DRAIN_TIMEOUT_MS ?? 120_000));
      await w.stop();
      process.exit(0);
    });
}
