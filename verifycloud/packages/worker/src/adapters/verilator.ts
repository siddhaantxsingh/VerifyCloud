// Verilator adapter (tested with Verilator 5.020; see docs/simulator-adapters.md).
//
// Build: verilator --cc --exe --build with the VerifyCloud harness
// (vc_main.cpp), which ends runs cleanly on $stop/$fatal/assertion failures
// and writes coverage.dat and an optional VCD. Run: the compiled model with
// plusargs. Results come from the harness summary line, Verilator's
// "Assertion failed" messages, and the testbench's own output.
import type { AssertionFailureRecord, CoverageDetail, CoverageType, ProjectConfig } from "@verifycloud/shared";
import { globMatch } from "@verifycloud/shared";

import type { BuildOutcome, BuildPlan, Diagnostic, ResolvedSources, RunOutcome, RunPlan, SimulatorAdapter } from "./types.js";

const sh = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;

export class VerilatorAdapter implements SimulatorAdapter {
  readonly engine = "verilator";

  detect(files: string[]) {
    return files.some((f) => /\.(sv|v)$/.test(f));
  }

  validate(cfg: ProjectConfig): string[] {
    const issues: string[] = [];
    if (cfg.simulator.flags.some((f) => /^--?(trace|coverage|assert|timing)/.test(f)))
      issues.push("simulator.flags: use the timing/assertions/coverage/waveform settings instead of --trace/--coverage/--assert/--timing flags");
    return issues;
  }

  cacheKeyMaterial(cfg: ProjectConfig, toolchain: Record<string, unknown>) {
    return {
      engine: "verilator",
      verilator: toolchain.verilator ?? null,
      gcc: toolchain.gcc ?? null,
      image: toolchain.imageDigest ?? null,
      harness: toolchain.harnessSha256 ?? null,
      top: cfg.testbench.top,
      timing: cfg.simulator.timing,
      assertions: cfg.simulator.assertions,
      coverage: cfg.simulator.coverage,
      waveform: cfg.simulator.waveform !== "never",
      flags: cfg.simulator.flags,
      defines: cfg.rtl.defines,
    };
  }

  private buildArgs(cfg: ProjectConfig, src: ResolvedSources, cpus: number, waveforms: boolean): string[] {
    const s = cfg.simulator;
    const a = ["verilator", "--cc", "--exe", "--build", "-j", String(Math.max(1, cpus)), "--top-module", cfg.testbench.top, "-Mdir", "/work/scratch/obj", "-o", "sim"];
    if (s.timing) a.push("--timing");
    else a.push("--no-timing");
    if (s.assertions) a.push("--assert");
    if (s.coverage.line || s.coverage.branch) a.push("--coverage-line");
    if (s.coverage.toggle) a.push("--coverage-toggle");
    if (s.coverage.functional) a.push("--coverage-user");
    if (waveforms) a.push("--trace");
    for (const d of src.includeDirs) a.push(`-I${d}`);
    for (const [k, v] of Object.entries(cfg.rtl.defines)) a.push(v === "" ? `+define+${k}` : `+define+${k}=${v}`);
    a.push(...s.flags, ...src.files, "/opt/verifycloud/harness/vc_main.cpp");
    return a;
  }

  buildPlan(cfg: ProjectConfig, src: ResolvedSources, cpus: number, waveforms: boolean): BuildPlan {
    const args = this.buildArgs(cfg, src, cpus, waveforms);
    const vcTop = `#include "V${cfg.testbench.top}.h"\n#define VC_TOP V${cfg.testbench.top}\n`;
    const script = [
      "#!/bin/sh",
      "set -e",
      "mkdir -p /work/scratch/obj /work/scratch/tmp",
      "cp /work/vc/vc_top.h /work/scratch/obj/vc_top.h",
      "cd /work/src",
      args.map(sh).join(" "),
      "cp /work/scratch/obj/sim /work/out/sim",
      "",
    ].join("\n");
    return {
      command: ["sh", "/work/vc/build.sh"],
      supportFiles: { "build.sh": script, "vc_top.h": vcTop },
      modelPath: "sim",
      display: args.join(" "),
    };
  }

  parseBuild(log: string, exitCode: number | null): BuildOutcome {
    const diagnostics: Diagnostic[] = [];
    for (const line of log.split("\n")) {
      // %Error: rtl/a.sv:12:5: message      %Warning-WIDTH: tb/t.sv:3:1: message
      let m = /^%(Error|Warning)(?:-[A-Z0-9_]+)?: ([^:\s]+):(\d+):(?:\d+:)? (.*)$/.exec(line);
      if (m) {
        diagnostics.push({ severity: m[1] === "Error" ? "error" : "warning", file: m[2]!, line: Number(m[3]), message: m[4]!.trim() });
        continue;
      }
      // g++: obj/V.cpp:10:3: error: message  (harness or generated code)
      m = /^([^:\s]+):(\d+):\d+: (error|warning): (.*)$/.exec(line);
      if (m) {
        diagnostics.push({ severity: m[3] as "error" | "warning", file: m[1]!, line: Number(m[2]), message: m[4]! });
        continue;
      }
      m = /^%Error: (.*)$/.exec(line);
      if (m && !/Exiting due to/.test(m[1]!)) diagnostics.push({ severity: "error", file: null, line: null, message: m[1]! });
    }
    const errors = diagnostics.filter((d) => d.severity === "error");
    const ok = exitCode === 0;
    return {
      ok,
      diagnostics: diagnostics.slice(0, 200),
      summary: ok ? `built (${diagnostics.filter((d) => d.severity === "warning").length} warning(s))` : errors[0] ? `${errors[0].file ? `${errors[0].file}:${errors[0].line}: ` : ""}${errors[0].message}` : `build failed with exit code ${exitCode}`,
    };
  }

  runPlan(cfg: ProjectConfig, plusargs: Record<string, string>, opts: { waveform: boolean; coverage: boolean }): RunPlan {
    const args = Object.entries(plusargs).map(([k, v]) => `+${k}=${v}`);
    const covOn = opts.coverage && Object.values(cfg.simulator.coverage).some(Boolean);
    if (covOn) args.push("+vc_coverage=/work/out/coverage.dat");
    if (opts.waveform) args.push("+vc_trace=/work/out/waves.vcd");
    const script = `mkdir -p /work/scratch/run && cp -R /work/src/. /work/scratch/run/ && cd /work/scratch/run && exec /work/model/sim ${args.map(sh).join(" ")}`;
    return { command: ["sh", "-c", script], coverageFile: covOn ? "coverage.dat" : null, waveformFile: opts.waveform ? "waves.vcd" : null };
  }

  parseRun(log: string, exitCode: number | null): RunOutcome {
    const assertions: AssertionFailureRecord[] = [];
    const checkFailures: string[] = [];
    let simTime: string | null = null;
    let finished = false;
    let simError = false;
    let tbFail = false;
    let tbPass = false;
    for (const line of log.split("\n")) {
      let m = /^\[(\d+)\] %(Error|Warning|Fatal): ([^:\s]+):(\d+): Assertion failed in ([^:\s]+):?\s*(.*)$/.exec(line);
      if (m) {
        const scope = m[5]!;
        const name = scope.split(".").pop()!;
        // $fatal/$error in procedural code is reported by Verilator in the
        // same format; it is a self-check, not a named assertion.
        if (/^unnamedblk\d*$/.test(name) || !scope.includes(".")) checkFailures.push(`${m[3]}:${m[4]} ${m[6]!.trim()}`);
        else
          assertions.push({
            name,
            scope,
            severity: m[2] === "Fatal" ? "fatal" : m[2] === "Warning" ? "warning" : "error",
            message: m[6]!.trim(),
            file: m[3]!,
            line: Number(m[4]),
            simTime: m[1]!,
          });
        continue;
      }
      if ((m = /^VC_SIM_END finish=(\d) error=(\d) time=(\d+)/.exec(line))) {
        finished = m[1] === "1";
        simError = m[2] === "1";
        simTime = m[3]!;
        continue;
      }
      if (/^VC_CHECK FAIL/.test(line)) checkFailures.push(line.replace(/^VC_CHECK FAIL\s*/, ""));
      else if (/^\[\d+\] %Error: [^:]+:\d+: /.test(line) && !/Assertion failed/.test(line)) checkFailures.push(line.replace(/^\[\d+\] %Error: /, ""));
      if (/^VC_RESULT FAIL/.test(line)) tbFail = true;
      if (/^VC_RESULT PASS/.test(line)) tbPass = true;
    }
    // self-check failures (VC_CHECK FAIL, procedural %Error) fail the run even
    // if the testbench calls $finish afterwards (audit 2026-10-08)
    const passed = exitCode === 0 && finished && !simError && assertions.length === 0 && checkFailures.length === 0 && !tbFail;
    let summary: string;
    if (passed) summary = tbPass ? "passed" : "passed (simulation finished without errors)";
    else if (assertions.length) summary = `assertion ${assertions[0]!.name} failed at ${assertions[0]!.file}:${assertions[0]!.line} (time ${assertions[0]!.simTime}): ${assertions[0]!.message}`;
    else if (checkFailures.length) summary = `self-check failed: ${checkFailures[0]}`;
    else if (exitCode === 3 || (!finished && exitCode === 0)) summary = "simulation ended without $finish (event queue empty)";
    else if (!log.includes("VC_SIM_END")) summary = `simulator exited with code ${exitCode} without completing (crash or kill)`;
    else summary = `failed (exit code ${exitCode})`;
    return { passed, summary, assertions: assertions.slice(0, 100), checkFailures: checkFailures.slice(0, 100), simTime, finished };
  }

  /**
   * coverage.dat: lines `C '<\x01key\x02value...>' <count>`. Point types come from
   * the "page" field (v_line, v_branch, v_toggle, v_user). Code coverage is
   * restricted to files matching coverage.include (if given); functional
   * coverage (cover properties) is always kept.
   */
  parseCoverage(data: Buffer, cfg: ProjectConfig, sourceFiles: string[]): CoverageDetail | null {
    const typeOf: Record<string, CoverageType> = { v_line: "line", v_branch: "branch", v_toggle: "toggle", v_user: "functional" };
    const enabled = cfg.simulator.coverage;
    const files: string[] = [];
    const fileIdx = new Map<string, number>();
    const points: CoverageDetail["points"] = [];
    const resolve = (f: string) => {
      if (sourceFiles.includes(f)) return f;
      const cands = sourceFiles.filter((s) => s.endsWith("/" + f));
      return cands.length === 1 ? cands[0]! : f;
    };
    for (const line of data.toString("latin1").split("\n")) {
      if (!line.startsWith("C '")) continue;
      const end = line.lastIndexOf("'");
      const key = line.slice(3, end);
      const count = Number(line.slice(end + 1).trim());
      const kv: Record<string, string> = {};
      for (const part of key.split("\x01")) {
        const i = part.indexOf("\x02");
        if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1);
      }
      const type = typeOf[(kv.page ?? "").split("/")[0]!];
      if (!type || !enabled[type]) continue;
      const file = resolve(kv.f ?? "?");
      if (type !== "functional" && cfg.coverage.include.length && !globMatch(cfg.coverage.include, file)) continue;
      let idx = fileIdx.get(file);
      if (idx === undefined) {
        idx = files.push(file) - 1;
        fileIdx.set(file, idx);
      }
      const label = type === "functional" ? (kv.h ?? kv.o ?? "").split(".").pop()! : `${kv.h ?? ""}|${kv.o ?? ""}|${kv.n ?? ""}`;
      points.push([idx, Number(kv.l ?? 0), type, Number.isFinite(count) ? count : 0, label]);
    }
    if (points.length === 0) return null;
    return { version: 1, tool: "verilator", files, points };
  }
}
