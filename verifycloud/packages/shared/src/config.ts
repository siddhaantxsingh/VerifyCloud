// verifycloud.yaml: parsing, validation and normalization.
//
// The configuration is the single source of truth for how a project is
// built and tested. It is validated strictly: unknown keys, wrong types and
// dangerous values are errors with a line number, never silently ignored or
// guessed (see docs/verification-model.md).
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node as YamlNode } from "yaml";

export const SUPPORTED_ENGINES = ["verilator"] as const;
export type Engine = (typeof SUPPORTED_ENGINES)[number];
export type WaveformMode = "never" | "on_failure" | "always";

export interface TestSpec {
  name: string;
  plusargs: Record<string, string>;
  seeds: number[];
  timeoutSeconds: number;
  retries: number;
}

export interface ProjectConfig {
  version: 1;
  project: { name: string };
  rtl: { sources: string[]; includeDirs: string[]; defines: Record<string, string> };
  testbench: { sources: string[]; top: string };
  simulator: {
    engine: Engine;
    timing: boolean;
    assertions: boolean;
    flags: string[];
    coverage: { line: boolean; branch: boolean; toggle: boolean; functional: boolean };
    waveform: WaveformMode;
    testPlusarg: string;
    seedPlusarg: string;
  };
  coverage: { include: string[] };
  tests: Record<string, TestSpec>;
  regressions: Record<string, { tests: string[] }>;
  resources: { cpu: number; memoryMb: number; compileMemoryMb: number; timeoutSeconds: number; compileTimeoutSeconds: number; diskMb: number };
}

export interface ConfigIssue {
  path: string;
  message: string;
  line?: number;
}

export class ConfigError extends Error {
  constructor(public readonly issues: ConfigIssue[]) {
    super(issues.map((i) => `${i.line ? `line ${i.line}: ` : ""}${i.path}: ${i.message}`).join("\n"));
  }
}

// Platform limits a configuration may not exceed (plans may lower them).
export const CONFIG_LIMITS = {
  maxTests: 500,
  maxSeedsPerTest: 1000,
  maxTestRunsPerRegression: 5000,
  maxCpu: 16,
  maxMemoryMb: 65536,
  maxTimeoutSeconds: 4 * 3600,
  maxDiskMb: 20480,
  maxRetries: 3,
};

// Simulator flags users may not pass: they would change where files go,
// pull in other inputs, run commands, or break the harness contract.
// Verilator accepts every option with one or two leading dashes, so flags are
// normalised to the "--name" form before this check (audit 2026-10-08: the
// single-dash forms used to bypass it). Also denied: flags that pull in files
// the configuration does not declare (-f/-F command files, -y/-v libraries,
// +incdir+/-I include paths — use rtl.include_dirs) and flags that change
// outputs, compilers or the harness contract.
const FORBIDDEN_FLAGS = new Set([
  "--mdir", "--exe", "--build", "--build-jobs", "--binary", "--main", "--o", "--f", "--top-module", "--top", "--prefix",
  "--cflags", "--ldflags", "--make", "--compiler", "--makeflags", "--x-initial", "--y", "--v", "--i", "--libext",
  "--no-timing", "--timing", "--assert", "--no-assert", "--coverage", "--coverage-line", "--coverage-toggle", "--coverage-user",
  "--trace", "--trace-fst", "--cc", "--sc", "--lib-create", "--dpi-hdr-only", "--xml-only", "--json-only", "--e", "--E", "--hierarchical",
]);
/** The canonical "--name" of a command-line flag, or null for plusargs-style options. */
export function canonicalFlag(flag: string): string {
  if (flag.startsWith("+")) return flag.toLowerCase().startsWith("+incdir+") ? "--i" : flag.toLowerCase().startsWith("+libext+") ? "--libext" : "";
  const name = flag.replace(/^-+/, "").split(/[= ]/)[0]!;
  // -Ipath, -Dname, -Wno-x: single-letter options with an attached value
  if (/^I./.test(name)) return "--i";
  if (/^[yv]$/.test(name)) return `--${name}`;
  if (name === "F") return "--f";
  return `--${name.toLowerCase()}`;
}
export function forbiddenFlag(flag: string): boolean {
  return FORBIDDEN_FLAGS.has(canonicalFlag(flag));
}
const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,127}$/;
const PLUSARG_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PLUSARG_VAL_RE = /^[A-Za-z0-9_.,:\/=-]{0,256}$/;

/** A path pattern relative to the repository root: no absolute paths, no "..". */
export function safeRelativePattern(p: string): boolean {
  if (!p || p.length > 512) return false;
  if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p)) return false;
  if (p.split(/[\\/]/).some((seg) => seg === "..")) return false;
  return !/[\0\n\r]/.test(p);
}

interface Ctx {
  issues: ConfigIssue[];
  lines: LineCounter;
}

function lineOf(ctx: Ctx, node: YamlNode | null | undefined): number | undefined {
  const r = (node as { range?: [number, number, number] } | null | undefined)?.range;
  return r ? ctx.lines.linePos(r[0]).line : undefined;
}

class V {
  constructor(private ctx: Ctx, readonly node: YamlNode | null | undefined, readonly path: string) {}
  issue(message: string, node: YamlNode | null | undefined = this.node) {
    this.ctx.issues.push({ path: this.path || "(root)", message, line: lineOf(this.ctx, node) });
  }
  get exists() {
    return this.node !== undefined && this.node !== null;
  }
  map(allowed: string[]): Map<string, V> | undefined {
    const out = new Map<string, V>();
    if (!this.exists) return out;
    if (!isMap(this.node)) {
      this.issue("must be a mapping");
      return undefined;
    }
    for (const pair of this.node.items) {
      const k = isScalar(pair.key) ? String(pair.key.value) : "";
      const child = new V(this.ctx, pair.value as YamlNode, this.path ? `${this.path}.${k}` : k);
      if (allowed.length && !allowed.includes(k)) child.issue(`unknown key "${k}" (allowed: ${allowed.join(", ")})`, pair.key as YamlNode);
      else out.set(k, child);
    }
    return out;
  }
  entries(): Map<string, V> {
    return this.map([]) ?? new Map();
  }
  scalar(): unknown {
    if (!this.exists) return undefined;
    if (!isScalar(this.node)) {
      this.issue("must be a single value");
      return undefined;
    }
    return this.node.value;
  }
  string(def?: string, re?: RegExp, what = "value"): string | undefined {
    if (!this.exists) return def;
    const v = this.scalar();
    if (typeof v !== "string" && typeof v !== "number") {
      this.issue(`must be a string`);
      return def;
    }
    const s = String(v);
    if (re && !re.test(s)) {
      this.issue(`invalid ${what} "${s.slice(0, 80)}"`);
      return def;
    }
    return s;
  }
  bool(def: boolean): boolean {
    if (!this.exists) return def;
    const v = this.scalar();
    if (typeof v !== "boolean") {
      this.issue("must be true or false");
      return def;
    }
    return v;
  }
  int(def: number, min: number, max: number): number {
    if (!this.exists) return def;
    const v = this.scalar();
    if (typeof v !== "number" || !Number.isInteger(v)) {
      this.issue("must be an integer");
      return def;
    }
    if (v < min || v > max) {
      this.issue(`must be between ${min} and ${max}`);
      return Math.min(max, Math.max(min, v));
    }
    return v;
  }
  list(): V[] {
    if (!this.exists) return [];
    if (!isSeq(this.node)) {
      this.issue("must be a list");
      return [];
    }
    return this.node.items.map((n, i) => new V(this.ctx, n as YamlNode, `${this.path}[${i}]`));
  }
  stringList(re?: RegExp, what?: string): string[] {
    return this.list()
      .map((x) => x.string(undefined, re, what))
      .filter((x): x is string => x !== undefined);
  }
}

function patterns(v: V | undefined, required: boolean): string[] {
  if (!v || !v.exists) {
    if (required && v) v.issue("is required");
    return [];
  }
  const out = v.stringList();
  out.forEach((p, i) => {
    if (!safeRelativePattern(p)) v.list()[i]?.issue(`path pattern "${p}" must be relative to the repository and must not contain ".."`);
  });
  if (required && out.length === 0) v.issue("must list at least one source pattern");
  return out.filter(safeRelativePattern);
}

function parseSeeds(v: V | undefined): number[] {
  if (!v || !v.exists) return [1];
  if (isSeq(v.node)) {
    const seeds = v.list().map((x) => x.int(1, 0, 2 ** 31 - 1));
    if (seeds.length === 0) v.issue("must list at least one seed");
    if (seeds.length > CONFIG_LIMITS.maxSeedsPerTest) v.issue(`at most ${CONFIG_LIMITS.maxSeedsPerTest} seeds per test`);
    return [...new Set(seeds)].slice(0, CONFIG_LIMITS.maxSeedsPerTest);
  }
  const m = v.map(["range"]);
  const r = m?.get("range");
  if (!r) {
    v.issue('must be a list of integers or { range: [first, last] }');
    return [1];
  }
  const [a, b] = r.list().map((x) => x.int(1, 0, 2 ** 31 - 1));
  if (a === undefined || b === undefined || b < a) {
    r.issue("range must be [first, last] with last >= first");
    return [1];
  }
  if (b - a + 1 > CONFIG_LIMITS.maxSeedsPerTest) {
    r.issue(`at most ${CONFIG_LIMITS.maxSeedsPerTest} seeds per test`);
    return [a];
  }
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

/** Parse and validate verifycloud.yaml text. Throws ConfigError with all issues found. */
export function parseConfig(text: string): ProjectConfig {
  if (text.length > 256 * 1024) throw new ConfigError([{ path: "(file)", message: "configuration larger than 256 KiB" }]);
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: true });
  const ctx: Ctx = { issues: [], lines };
  for (const e of doc.errors) ctx.issues.push({ path: "(syntax)", message: e.message.split("\n")[0]!, line: e.linePos?.[0]?.line });
  if (ctx.issues.length) throw new ConfigError(ctx.issues);
  const root = new V(ctx, doc.contents as YamlNode, "");
  if (!root.exists) throw new ConfigError([{ path: "(root)", message: "configuration is empty" }]);
  const top = root.map(["version", "project", "rtl", "testbench", "simulator", "coverage", "tests", "regressions", "regression", "resources"]) ?? new Map();

  const version = top.get("version");
  if (!version) ctx.issues.push({ path: "version", message: "is required (use version: 1)" });
  else if (version.int(1, 1, 1) !== 1) version.issue("only version 1 is supported");

  const project = top.get("project")?.map(["name"]);
  const name = project?.get("name")?.string(undefined, NAME_RE, "project name");
  if (!name) (top.get("project") ?? root).issue("project.name is required");

  const rtl = top.get("rtl")?.map(["sources", "include_dirs", "defines"]);
  if (!top.get("rtl")) root.issue("rtl.sources is required");
  const defines: Record<string, string> = {};
  for (const [k, v] of rtl?.get("defines")?.entries() ?? []) {
    if (!IDENT_RE.test(k)) v.issue(`invalid define name "${k}"`);
    else defines[k] = v.string("", PLUSARG_VAL_RE, "define value") ?? "";
  }

  const tbNode = top.get("testbench");
  const tb = tbNode?.map(["sources", "top"]);
  if (!tbNode) root.issue("testbench (sources and top) is required");
  const tbTop = tb?.get("top")?.string(undefined, IDENT_RE, "top module name");
  if (tbNode && !tbTop) tbNode.issue("testbench.top (the top-level module) is required");

  const simNode = top.get("simulator");
  const sim = simNode?.map(["engine", "timing", "assertions", "flags", "coverage", "waveform", "test_plusarg", "seed_plusarg"]);
  if (!simNode) root.issue("simulator.engine is required");
  const engine = sim?.get("engine")?.string(undefined);
  if (simNode && !engine) simNode.issue("simulator.engine is required");
  else if (engine && !(SUPPORTED_ENGINES as readonly string[]).includes(engine))
    sim?.get("engine")?.issue(`unsupported simulator "${engine}" (supported: ${SUPPORTED_ENGINES.join(", ")})`);
  const flags = sim?.get("flags")?.stringList() ?? [];
  sim
    ?.get("flags")
    ?.list()
    .forEach((f: V, i: number) => {
      const flag = flags[i] ?? "";
      if (forbiddenFlag(flag))
        f.issue(`flag "${flag}" is controlled by VerifyCloud and may not be set`);
      else if (!/^[-+A-Za-z0-9_=.,:\/]{1,200}$/.test(flag)) f.issue(`flag "${flag.slice(0, 60)}" contains characters that are not allowed`);
    });
  const covNode = sim?.get("coverage");
  let coverage = { line: false, branch: false, toggle: false, functional: false };
  if (covNode?.exists && isScalar(covNode.node)) {
    const all = covNode.bool(false);
    coverage = { line: all, branch: all, toggle: all, functional: all };
  } else if (covNode) {
    const c = covNode.map(["line", "branch", "toggle", "functional"]);
    coverage = {
      line: c?.get("line")?.bool(false) ?? false,
      branch: c?.get("branch")?.bool(false) ?? false,
      toggle: c?.get("toggle")?.bool(false) ?? false,
      functional: c?.get("functional")?.bool(false) ?? false,
    };
  }
  const waveform = (sim?.get("waveform")?.string("on_failure") ?? "on_failure") as WaveformMode;
  if (!["never", "on_failure", "always"].includes(waveform)) sim?.get("waveform")?.issue("must be never, on_failure or always");

  const rtlSources = patterns(rtl?.get("sources"), true);
  const includeDirs = patterns(rtl?.get("include_dirs"), false);
  const tbSources = patterns(tb?.get("sources"), true);
  const covInclude = patterns(top.get("coverage")?.map(["include"])?.get("include"), false);

  const resNode = top.get("resources");
  const res = resNode?.map(["cpu", "memory_mb", "compile_memory_mb", "timeout_seconds", "compile_timeout_seconds", "disk_mb"]);
  const memoryMb = res?.get("memory_mb")?.int(2048, 256, CONFIG_LIMITS.maxMemoryMb) ?? 2048;
  const resources = {
    cpu: res?.get("cpu")?.int(1, 1, CONFIG_LIMITS.maxCpu) ?? 1,
    memoryMb,
    // compiling the Verilated model (C++) usually needs more memory than running it
    compileMemoryMb: res?.get("compile_memory_mb")?.int(2048, 512, CONFIG_LIMITS.maxMemoryMb) ?? Math.max(memoryMb, 2048),
    timeoutSeconds: res?.get("timeout_seconds")?.int(300, 5, CONFIG_LIMITS.maxTimeoutSeconds) ?? 300,
    compileTimeoutSeconds: res?.get("compile_timeout_seconds")?.int(600, 10, CONFIG_LIMITS.maxTimeoutSeconds) ?? 600,
    diskMb: res?.get("disk_mb")?.int(2048, 128, CONFIG_LIMITS.maxDiskMb) ?? 2048,
  };

  const testPlusarg = sim?.get("test_plusarg")?.string("TEST", PLUSARG_KEY_RE, "plusarg name") ?? "TEST";
  const seedPlusarg = sim?.get("seed_plusarg")?.string("SEED", PLUSARG_KEY_RE, "plusarg name") ?? "SEED";

  // tests
  const tests: Record<string, TestSpec> = {};
  const testsNode = top.get("tests");
  for (const [tname, tv] of testsNode?.entries() ?? []) {
    if (!NAME_RE.test(tname)) {
      tv.issue(`invalid test name "${tname}"`);
      continue;
    }
    const t = tv.map(["plusargs", "seeds", "timeout_seconds", "retries"]);
    const plusargs: Record<string, string> = {};
    for (const [k, v] of t?.get("plusargs")?.entries() ?? []) {
      if (!PLUSARG_KEY_RE.test(k)) v.issue(`invalid plusarg name "${k}"`);
      else if (/^vc_/i.test(k)) v.issue(`plusarg "${k}" is reserved by VerifyCloud (vc_*)`);
      else if (k === seedPlusarg) v.issue(`"${k}" is set from the test's seeds; do not set it here`);
      else plusargs[k] = v.string("", PLUSARG_VAL_RE, "plusarg value") ?? "";
    }
    if (!(testPlusarg in plusargs)) plusargs[testPlusarg] = tname;
    tests[tname] = {
      name: tname,
      plusargs,
      seeds: parseSeeds(t?.get("seeds")),
      timeoutSeconds: t?.get("timeout_seconds")?.int(resources.timeoutSeconds, 1, CONFIG_LIMITS.maxTimeoutSeconds) ?? resources.timeoutSeconds,
      retries: t?.get("retries")?.int(0, 0, CONFIG_LIMITS.maxRetries) ?? 0,
    };
  }

  // regressions (and the shorthand `regression: { tests: [...] }`)
  const regressions: Record<string, { tests: string[] }> = {};
  const addRegression = (rname: string, rv: V) => {
    const r = rv.map(["tests"]);
    const list = r?.get("tests")?.stringList() ?? [];
    if (list.length === 0) rv.issue("must list at least one test");
    for (const [i, t] of list.entries()) {
      if (!tests[t]) {
        // A test named only in a regression is allowed: it gets defaults.
        if (!NAME_RE.test(t)) r?.get("tests")?.list()[i]?.issue(`invalid test name "${t}"`);
        else tests[t] = { name: t, plusargs: { [testPlusarg]: t }, seeds: [1], timeoutSeconds: resources.timeoutSeconds, retries: 0 };
      }
    }
    regressions[rname] = { tests: [...new Set(list)] };
  };
  for (const [rname, rv] of top.get("regressions")?.entries() ?? []) {
    if (!NAME_RE.test(rname)) rv.issue(`invalid regression name "${rname}"`);
    else addRegression(rname, rv);
  }
  const shorthand = top.get("regression");
  if (shorthand) {
    if (regressions.default) shorthand.issue('"regression" shorthand conflicts with regressions.default');
    else addRegression("default", shorthand);
  }
  if (Object.keys(regressions).length === 0) root.issue("define at least one regression (regressions: or regression:)");
  if (Object.keys(tests).length > CONFIG_LIMITS.maxTests) root.issue(`at most ${CONFIG_LIMITS.maxTests} tests`);
  for (const [rname, r] of Object.entries(regressions)) {
    const runs = r.tests.reduce((n, t) => n + (tests[t]?.seeds.length ?? 0), 0);
    if (runs > CONFIG_LIMITS.maxTestRunsPerRegression)
      root.issue(`regression "${rname}" expands to ${runs} test runs (limit ${CONFIG_LIMITS.maxTestRunsPerRegression})`);
  }

  if (ctx.issues.length) throw new ConfigError(ctx.issues);
  return {
    version: 1,
    project: { name: name! },
    rtl: { sources: rtlSources, includeDirs, defines },
    testbench: { sources: tbSources, top: tbTop! },
    simulator: { engine: engine as Engine, timing: sim?.get("timing")?.bool(false) ?? false, assertions: sim?.get("assertions")?.bool(true) ?? true, flags, coverage, waveform, testPlusarg, seedPlusarg },
    coverage: { include: covInclude },
    tests,
    regressions,
    resources,
  };
}

/** Like parseConfig but returns issues instead of throwing (UI validation). */
export function validateConfig(text: string): { ok: true; config: ProjectConfig } | { ok: false; issues: ConfigIssue[] } {
  try {
    return { ok: true, config: parseConfig(text) };
  } catch (e) {
    if (e instanceof ConfigError) return { ok: false, issues: e.issues };
    throw e;
  }
}

export interface PlannedTestRun {
  test: string;
  seed: number;
  plusargs: Record<string, string>;
  timeoutSeconds: number;
  retries: number;
}

/** Expand a regression into concrete (test, seed) runs, in a stable order. */
export function expandRegression(cfg: ProjectConfig, regression: string, only?: string[]): PlannedTestRun[] {
  const r = cfg.regressions[regression];
  if (!r) throw new ConfigError([{ path: "regression", message: `unknown regression "${regression}" (defined: ${Object.keys(cfg.regressions).join(", ")})` }]);
  const names = only?.length ? r.tests.filter((t) => only.includes(t)) : r.tests;
  const out: PlannedTestRun[] = [];
  for (const name of names) {
    const t = cfg.tests[name]!;
    for (const seed of t.seeds)
      out.push({ test: name, seed, plusargs: { ...t.plusargs, [cfg.simulator.seedPlusarg]: String(seed) }, timeoutSeconds: t.timeoutSeconds, retries: t.retries });
  }
  return out;
}
