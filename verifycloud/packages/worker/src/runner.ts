// Executes one claimed task (build or test) end to end:
//   sources → sandbox → parse → upload artifacts → report.
// While running, the lease is renewed; a lost lease aborts the run (another
// worker owns the task now) and nothing is reported.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { parseVcd, summarize, type ProjectConfig } from "@verifycloud/shared";

import type { SimulatorAdapter } from "./adapters/types.js";
import { VerilatorAdapter } from "./adapters/verilator.js";
import { LeaseLostError, ReregisterError, type ClaimedTask, type WorkerApi } from "./api.js";
import type { WorkerConfig } from "./config.js";
import { readUntrusted } from "./safefs.js";
import type { RunResult, Sandbox } from "./sandbox.js";
import { applyPatch, cacheKey, extractSnapshot, gitFetch, listFiles, resolveSources, snapshotTree, SourceError } from "./sources.js";

const ADAPTERS: Record<string, SimulatorAdapter> = { verilator: new VerilatorAdapter() };

type Log = { info: (m: string, o?: object) => void; warn: (m: string, o?: object) => void };

export interface TaskContext {
  cfg: WorkerConfig;
  api: WorkerApi;
  sandbox: Sandbox;
  toolchain: Record<string, unknown>;
  log: Log;
}

export async function runTask(tc: TaskContext, claim: ClaimedTask): Promise<void> {
  const { api, cfg, log } = tc;
  const { task, leaseToken: lease, job } = claim;
  const dir = join(cfg.workDir, task.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let cancel = false;
  let lost = false;
  const hb = setInterval(async () => {
    try {
      const r = await api.heartbeatTask(task.id, lease);
      if (r.cancel) cancel = true;
    } catch (e) {
      if (e instanceof LeaseLostError || e instanceof ReregisterError) {
        lost = true;
        cancel = true;
      }
    }
  }, Math.max(2000, (claim.leaseSeconds * 1000) / 3));
  const t0 = Date.now();
  try {
    const report = task.kind === "build" ? await build(tc, claim, dir, () => cancel) : await test(tc, claim, dir, () => cancel);
    if (lost) {
      log.warn("lease lost during the run; result discarded", { task: task.id });
      return;
    }
    await api.complete(task.id, lease, report);
    log.info("task finished", { task: task.id, kind: task.kind, state: report.state, ms: Date.now() - t0 });
  } catch (e) {
    if (e instanceof LeaseLostError || e instanceof ReregisterError || lost) {
      log.warn("lease lost; result discarded", { task: task.id });
      return;
    }
    const msg = (e as Error).message;
    const userError = e instanceof SourceError;
    log.warn("task failed", { task: task.id, err: msg });
    // source/config problems are the user's (not retryable); anything else is infrastructure
    await api
      .complete(task.id, lease, { state: userError ? "FAILED" : "ERROR", retryable: !userError, error: msg.slice(0, 1000), durationMs: Date.now() - t0, result: { summary: msg.slice(0, 500) } })
      .catch((err) => log.warn("could not report failure", { task: task.id, err: (err as Error).message }));
  } finally {
    clearInterval(hb);
    removeTaskDir(dir, log);
  }
}

/** The sandbox may leave read-only directories behind (chmod 555); restore write permission before removal and never throw. */
function removeTaskDir(dir: string, log: TaskContext["log"]) {
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    /* fall through */
  }
  try {
    const fix = (d: string) => {
      chmodSync(d, 0o700);
      for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) fix(join(d, e.name));
    };
    fix(dir);
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    log.warn("could not remove task directory", { dir, err: (e as Error).message });
  }
}

function sandboxState(r: RunResult): "TIMED_OUT" | "RESOURCE_EXCEEDED" | "CANCELLED" | null {
  if (r.cancelled) return "CANCELLED";
  if (r.timedOut) return "TIMED_OUT";
  if (r.oomKilled || r.outputExceeded || r.diskExceeded) return "RESOURCE_EXCEEDED";
  return null;
}

function resourceNote(r: RunResult, task: { memoryMb: number; timeoutSeconds: number }): string | null {
  if (r.timedOut) return `exceeded the time limit of ${task.timeoutSeconds} s`;
  if (r.oomKilled) return `exceeded the memory limit of ${task.memoryMb} MiB`;
  if (r.outputExceeded) return "produced more output than allowed (output flood); run killed";
  if (r.diskExceeded) return "wrote more files than allowed; run killed";
  if (r.cancelled) return "cancelled";
  return null;
}

async function uploadLog(tc: TaskContext, claim: ClaimedTask, name: string, r: RunResult): Promise<string> {
  let text = r.log;
  if (r.droppedBytes > 0) text += `\n[verifycloud] log truncated: ${r.droppedBytes} further bytes were produced and not stored (limit ${tc.cfg.limits.maxLogBytes} bytes)\n`;
  return tc.api.upload(claim.task.id, claim.leaseToken, {
    kind: "log",
    name,
    contentType: "text/plain; charset=utf-8",
    encoding: "gzip",
    body: gzipSync(Buffer.from(text, "utf8")),
    meta: { truncated: r.droppedBytes > 0, droppedBytes: r.droppedBytes, bytes: Buffer.byteLength(r.log) },
  });
}

/** Get the job's sources into dir/src. For repository sources, also return the snapshot artifact created from them. */
async function obtainSources(tc: TaskContext, claim: ClaimedTask, dir: string): Promise<{ srcDir: string; sourceArtifactId: string | null }> {
  const { api, cfg } = tc;
  const { task, leaseToken: lease, job } = claim;
  const srcDir = join(dir, "src");
  let sourceArtifactId: string | null = null;
  if (job.source.artifactId) {
    const gz = await api.download(task.id, lease, job.source.artifactId);
    await extractSnapshot(gz, srcDir, cfg.limits.maxRepoBytes);
  } else if (job.source.type === "github") {
    const creds = await api.gitCredentials(task.id, lease);
    gitFetch(srcDir, creds, cfg.limits.gitTimeoutMs);
    listFiles(srcDir); // refuses symlinks
    const gz = snapshotTree(srcDir, cfg.limits.maxRepoBytes);
    sourceArtifactId = await api.upload(task.id, lease, { kind: "source", name: "source.tar.gz", contentType: "application/gzip", body: gz, meta: { commit: job.commitSha } });
  } else throw new SourceError("job has no source");
  if (job.patch) {
    try {
      applyPatch(srcDir, job.patch);
    } catch (e) {
      throw new SourceError(`patch does not apply: ${(e as Error).message}`);
    }
  }
  return { srcDir, sourceArtifactId };
}

async function build(tc: TaskContext, claim: ClaimedTask, dir: string, shouldCancel: () => boolean): Promise<Record<string, unknown>> {
  const { api, sandbox, cfg, toolchain } = tc;
  const { task, leaseToken: lease, job } = claim;
  const config = job.config as ProjectConfig;
  const adapter = ADAPTERS[config.simulator.engine];
  if (!adapter) throw new SourceError(`no adapter for simulator "${config.simulator.engine}"`);
  const problems = adapter.validate(config);
  if (problems.length) throw new SourceError(problems.join("; "));
  const t0 = Date.now();
  const { srcDir, sourceArtifactId } = await obtainSources(tc, claim, dir);
  const src = resolveSources(srcDir, config);
  const waveforms = config.simulator.waveform !== "never";
  const key = cacheKey({ ...adapter.cacheKeyMaterial(config, toolchain), patch: job.patch ? createHash("sha256").update(job.patch).digest("hex") : null }, src);
  const tcInfo = { ...toolchain, simulatorVersion: toolchain.verilator ?? null, cacheKey: key };
  const plan = adapter.buildPlan(config, src, task.cpu, waveforms);

  const hit = await api.cacheLookup(task.id, lease, key);
  if (hit.hit && hit.artifactId) {
    return {
      state: "PASSED", durationMs: Date.now() - t0, modelArtifactId: hit.artifactId, sourceArtifactId, cacheKey: key, cacheHit: true, toolchain: tcInfo,
      result: { summary: "build cache hit (model reused)", command: plan.display, files: src.files, cacheHit: true, diagnostics: [] },
    };
  }
  const vcDir = join(dir, "vc");
  const outDir = join(dir, "out");
  const scratch = join(dir, "scratch");
  for (const d of [vcDir, outDir, scratch]) mkdirSync(d, { recursive: true });
  for (const [n, content] of Object.entries(plan.supportFiles)) writeFileSync(join(vcDir, n), content, { mode: 0o644 });
  // the sandbox user must be able to write the output directory
  for (const d of [outDir, scratch]) execChmod(d);
  const r = await sandbox.run({
    command: plan.command,
    mounts: [{ host: srcDir, container: "/work/src", readOnly: true }, { host: vcDir, container: "/work/vc", readOnly: true }],
    outDir: { host: outDir, container: "/work/out", readOnly: false },
    workdir: "/work/src",
    cpu: task.cpu,
    memoryMb: task.memoryMb,
    diskMb: config.resources.diskMb,
    scratchHost: scratch,
    timeoutMs: task.timeoutSeconds * 1000,
    maxLogBytes: cfg.limits.maxLogBytes,
    hardOutputBytes: cfg.limits.hardOutputBytes,
    maxOutDirBytes: cfg.limits.maxOutDirBytes,
    pids: cfg.limits.pids,
    env: { TMPDIR: "/work/scratch/tmp" },
    shouldCancel,
  });
  if (r.infraError) return { state: "ERROR", retryable: true, error: r.infraError, durationMs: Date.now() - t0 };
  const logId = await uploadLog(tc, claim, "build.log", r);
  const sb = sandboxState(r);
  const parsed = adapter.parseBuild(r.log, r.exitCode);
  const base = { durationMs: Date.now() - t0, cpuSeconds: r.cpuSeconds, exitCode: r.exitCode, sourceArtifactId, cacheKey: key, toolchain: tcInfo };
  const result = { summary: resourceNote(r, task) ?? parsed.summary, diagnostics: parsed.diagnostics, command: plan.display, files: src.files, logArtifactId: logId, logTruncated: r.droppedBytes > 0 };
  if (sb) return { ...base, state: sb, result, error: resourceNote(r, task) };
  if (!parsed.ok) return { ...base, state: "FAILED", result, error: parsed.summary };
  // the output directory is written by untrusted code: no symlinks, FIFOs or oversized files
  const m = readUntrusted(join(outDir, plan.modelPath), cfg.limits.maxOutDirBytes);
  if (!m.ok) return { ...base, state: "FAILED", result, error: `compiled model ${m.reason}` };
  const bin = m.data;
  const modelArtifactId = await api.upload(task.id, lease, { kind: "model", name: "sim.gz", contentType: "application/octet-stream", encoding: "gzip", body: gzipSync(bin), meta: { bytes: bin.length, cacheKey: key } });
  return { ...base, state: "PASSED", modelArtifactId, cacheHit: false, result };
}

function execChmod(d: string) {
  // container uid 10001 writes here; the directory itself is private to this task
  try {
    chmodSync(d, 0o777);
  } catch {
    /* ignore */
  }
}

async function test(tc: TaskContext, claim: ClaimedTask, dir: string, shouldCancel: () => boolean): Promise<Record<string, unknown>> {
  const { api, sandbox, cfg } = tc;
  const { task, leaseToken: lease, job } = claim;
  const config = job.config as ProjectConfig;
  const adapter = ADAPTERS[config.simulator.engine]!;
  const t0 = Date.now();
  const { srcDir } = await obtainSources(tc, claim, dir);
  if (!task.modelArtifactId) throw new Error("test task without a compiled model");
  const modelDir = join(dir, "model");
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(join(modelDir, "sim"), gunzipSync(await api.download(task.id, lease, task.modelArtifactId)), { mode: 0o755 });
  const outDir = join(dir, "out");
  const scratch = join(dir, "scratch");
  for (const d of [outDir, scratch]) {
    mkdirSync(d, { recursive: true });
    execChmod(d);
  }
  const waveMode = config.simulator.waveform;
  const plan = adapter.runPlan(config, task.plusargs, { waveform: waveMode !== "never", coverage: true });
  const r = await sandbox.run({
    command: plan.command,
    mounts: [{ host: srcDir, container: "/work/src", readOnly: true }, { host: modelDir, container: "/work/model", readOnly: true }],
    outDir: { host: outDir, container: "/work/out", readOnly: false },
    workdir: "/work/src",
    cpu: task.cpu,
    memoryMb: task.memoryMb,
    diskMb: config.resources.diskMb,
    scratchHost: scratch,
    timeoutMs: task.timeoutSeconds * 1000,
    maxLogBytes: cfg.limits.maxLogBytes,
    hardOutputBytes: cfg.limits.hardOutputBytes,
    maxOutDirBytes: cfg.limits.maxOutDirBytes,
    pids: cfg.limits.pids,
    env: { TMPDIR: "/work/scratch" },
    shouldCancel,
  });
  if (r.infraError) return { state: "ERROR", retryable: true, error: r.infraError, durationMs: Date.now() - t0 };
  const logId = await uploadLog(tc, claim, `${task.testName}-seed${task.seed}.log`, r);
  const parsed = adapter.parseRun(r.log, r.exitCode);
  const sb = sandboxState(r);
  const state = sb ?? (parsed.passed ? "PASSED" : "FAILED");

  // coverage
  let coverage: Record<string, unknown> | null = null;
  const notes: string[] = [];
  const cov = plan.coverageFile ? readUntrusted(join(outDir, plan.coverageFile), cfg.limits.maxOutDirBytes) : null;
  if (cov && !cov.ok && cov.reason !== "missing") notes.push(`coverage file ${cov.reason}`);
  if (cov?.ok) {
    const detail = adapter.parseCoverage(cov.data, config, listFiles(srcDir));
    if (detail) {
      const id = await api.upload(task.id, lease, { kind: "coverage", name: "coverage.json.gz", contentType: "application/json", encoding: "gzip", body: gzipSync(JSON.stringify(detail)) });
      coverage = { summary: summarize(detail), detailArtifactId: id };
    }
  }
  // waveform: kept when configured (always, or on failure)
  let waveformArtifactId: string | null = null;
  const wf = plan.waveformFile && (waveMode === "always" || state !== "PASSED") ? readUntrusted(join(outDir, plan.waveformFile), cfg.limits.maxWaveformBytes) : null;
  if (wf && !wf.ok && wf.reason !== "missing") notes.push(`waveform ${wf.reason}; not stored`);
  if (wf?.ok) {
    const size = wf.data.length;
    {
      const vcd = wf.data;
      waveformArtifactId = await api.upload(task.id, lease, { kind: "waveform", name: "waves.vcd.gz", contentType: "text/x-vcd", encoding: "gzip", body: gzipSync(vcd), meta: { format: "vcd", bytes: size } });
      try {
        const idx = parseVcd(vcd.toString("latin1"));
        await api.upload(task.id, lease, { kind: "waveform_index", name: "waves.index.json.gz", contentType: "application/json", encoding: "gzip", body: gzipSync(JSON.stringify(idx)), meta: { signals: idx.signals.length, truncated: idx.truncated, waveformArtifactId } });
        if (idx.truncated) notes.push("waveform index truncated (too many value changes); the full VCD is downloadable");
      } catch (e) {
        notes.push(`waveform could not be indexed: ${(e as Error).message}`);
      }
    }
  }
  const resNote = resourceNote(r, task);
  return {
    state,
    exitCode: r.exitCode,
    durationMs: Date.now() - t0,
    cpuSeconds: r.cpuSeconds,
    error: resNote,
    assertions: parsed.assertions,
    coverage,
    result: {
      summary: resNote ? `${resNote}${parsed.summary ? `; ${parsed.summary}` : ""}` : parsed.summary,
      checkFailures: parsed.checkFailures,
      simTime: parsed.simTime,
      finished: parsed.finished,
      logArtifactId: logId,
      logTruncated: r.droppedBytes > 0,
      waveformArtifactId,
      notes,
      command: plan.command.join(" "),
    },
  };
}
