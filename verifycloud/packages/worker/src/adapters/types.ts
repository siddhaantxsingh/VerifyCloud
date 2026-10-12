// Simulator adapter interface (docs/simulator-adapters.md, ADR-001).
//
// The worker core (sources, sandbox, artifacts, leases) is simulator-agnostic;
// everything simulator-specific lives behind this interface. An adapter turns
// a validated project configuration into sandbox commands and turns the
// simulator's output back into structured results.
import type { AssertionFailureRecord, CoverageDetail, ProjectConfig } from "@verifycloud/shared";

export interface ResolvedSources {
  files: string[];        // ordered compile list, repository-relative
  includeDirs: string[];
  /** sha256 of each file in `files` and every file under the include dirs */
  hashes: Record<string, string>;
}

export interface Diagnostic {
  severity: "error" | "warning";
  file: string | null;
  line: number | null;
  message: string;
}

export interface BuildPlan {
  /** argv executed in the sandbox with /work/src (ro), /work/vc (ro, adapter files), /work/out (rw) */
  command: string[];
  /** files the adapter needs next to the sources (written by the worker into /work/vc) */
  supportFiles: Record<string, string>;
  /** path of the compiled model inside /work/out after a successful build */
  modelPath: string;
  /** a human-readable equivalent command line, recorded for reproduction */
  display: string;
}

export interface RunPlan {
  command: string[];
  coverageFile: string | null;  // inside /work/out
  waveformFile: string | null;  // inside /work/out
}

export interface BuildOutcome {
  ok: boolean;
  diagnostics: Diagnostic[];
  summary: string;
}

export interface RunOutcome {
  passed: boolean;
  summary: string;
  assertions: AssertionFailureRecord[];
  checkFailures: string[];
  simTime: string | null;
  finished: boolean;
}

export interface SimulatorAdapter {
  readonly engine: string;
  /** Whether the sources look like a project this adapter can build (used by detection). */
  detect(files: string[]): boolean;
  /** Adapter-specific validation beyond the generic config schema. */
  validate(cfg: ProjectConfig): string[];
  /** Inputs that must be part of the build cache key besides source hashes. */
  cacheKeyMaterial(cfg: ProjectConfig, toolchain: Record<string, unknown>): Record<string, unknown>;
  buildPlan(cfg: ProjectConfig, src: ResolvedSources, cpus: number, waveforms: boolean): BuildPlan;
  parseBuild(log: string, exitCode: number | null): BuildOutcome;
  runPlan(cfg: ProjectConfig, plusargs: Record<string, string>, opts: { waveform: boolean; coverage: boolean }): RunPlan;
  parseRun(log: string, exitCode: number | null): RunOutcome;
  /** Parse the simulator's coverage database (only metrics it really produced). */
  parseCoverage(data: Buffer, cfg: ProjectConfig, sourceFiles: string[]): CoverageDetail | null;
}
