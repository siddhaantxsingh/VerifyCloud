// HDL project detection: inspects a file list (and optionally contents) and
// proposes a verifycloud.yaml. Detection never replaces the configuration:
// the proposal is shown to the user, who commits it. Every guess is reported
// with the reason, and ambiguous cases are listed as questions.
import picomatch from "picomatch";

export interface DetectedFile {
  path: string;
  content?: string; // first bytes, optional
}

export interface DetectionReport {
  hdlFiles: { sv: number; v: number; vh: number; svh: number };
  packages: string[];
  interfaces: string[];
  modules: string[];
  testbenchCandidates: string[];
  uvm: boolean;
  scripts: string[];
  hasConfig: boolean;
  findings: string[]; // human-readable reasoning
  questions: string[]; // what the user must decide
  proposedConfig: string | null;
}

const MODULE_RE = /^\s*module\s+(?:automatic\s+|static\s+)?([A-Za-z_][A-Za-z0-9_$]*)/gm;
const PKG_RE = /^\s*package\s+([A-Za-z_][A-Za-z0-9_$]*)\s*;/gm;
const IFACE_RE = /^\s*interface\s+(?:class\s+)?([A-Za-z_][A-Za-z0-9_$]*)/gm;

export function globMatch(patterns: string[], path: string): boolean {
  return patterns.some((p) => picomatch.isMatch(path, p, { dot: false }));
}

export function detectProject(files: DetectedFile[]): DetectionReport {
  const r: DetectionReport = {
    hdlFiles: { sv: 0, v: 0, vh: 0, svh: 0 },
    packages: [],
    interfaces: [],
    modules: [],
    testbenchCandidates: [],
    uvm: false,
    scripts: [],
    hasConfig: false,
    findings: [],
    questions: [],
    proposedConfig: null,
  };
  const rtlDirs = new Set<string>();
  const tbFiles: string[] = [];
  for (const f of files) {
    const p = f.path;
    if (p === "verifycloud.yaml" || p === "verifycloud.yml") r.hasConfig = true;
    const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
    if (ext in r.hdlFiles) r.hdlFiles[ext as keyof DetectionReport["hdlFiles"]]++;
    if (/(^|\/)(Makefile|makefile|.*\.mk|.*\.f|.*\.tcl|run.*\.sh)$/.test(p)) r.scripts.push(p);
    if (!["sv", "v"].includes(ext)) continue;
    const text = f.content ?? "";
    for (const m of text.matchAll(MODULE_RE)) r.modules.push(m[1]!);
    for (const m of text.matchAll(PKG_RE)) r.packages.push(m[1]!);
    for (const m of text.matchAll(IFACE_RE)) r.interfaces.push(m[1]!);
    if (/uvm_pkg|`uvm_|extends\s+uvm_/.test(text)) r.uvm = true;
    const isTb = /(^|\/)(tb|test|tests|verif|sim|dv)\//i.test(p) || /(^|\/)(tb_|test_)|_tb\.s?v$/i.test(p);
    if (isTb) {
      tbFiles.push(p);
      // a module without ports that the file names like a testbench is a top candidate
      for (const m of text.matchAll(/^\s*module\s+([A-Za-z_][A-Za-z0-9_$]*)\s*;/gm)) r.testbenchCandidates.push(m[1]!);
    } else {
      rtlDirs.add(p.includes("/") ? p.slice(0, p.indexOf("/")) : ".");
    }
  }
  const nHdl = r.hdlFiles.sv + r.hdlFiles.v;
  r.findings.push(`${nHdl} Verilog/SystemVerilog source file(s), ${r.hdlFiles.svh + r.hdlFiles.vh} header file(s)`);
  if (r.modules.length) r.findings.push(`modules: ${r.modules.slice(0, 20).join(", ")}${r.modules.length > 20 ? ", …" : ""}`);
  if (r.packages.length) r.findings.push(`packages: ${r.packages.join(", ")}`);
  if (r.interfaces.length) r.findings.push(`interfaces: ${r.interfaces.join(", ")}`);
  if (r.uvm) {
    r.findings.push("UVM usage detected (uvm_pkg / `uvm_ macros)");
    r.questions.push("UVM testbenches are not supported by the Verilator adapter in this release (Verilator 5.020 cannot compile the UVM library); a non-UVM SystemVerilog or C++ testbench is required.");
  }
  if (r.scripts.length) r.findings.push(`build scripts found (not executed): ${r.scripts.slice(0, 10).join(", ")}`);
  if (r.testbenchCandidates.length === 0) r.questions.push("No testbench top module found (a port-less module in a tb/ or *_tb file). Set testbench.top.");
  if (r.testbenchCandidates.length > 1) r.questions.push(`Several testbench top candidates: ${r.testbenchCandidates.join(", ")}. Choose testbench.top.`);
  if (nHdl === 0) {
    r.questions.push("No HDL sources found.");
    return r;
  }
  const rtlGlobs = [...rtlDirs].filter((d) => d !== ".").map((d) => `${d}/**/*.{sv,v}`);
  if (rtlDirs.has(".")) rtlGlobs.push("*.{sv,v}");
  const top = r.testbenchCandidates[0] ?? "tb_top";
  r.proposedConfig = [
    "# Proposed by VerifyCloud project detection. Review every line before committing.",
    "version: 1",
    "project:",
    "  name: my-project",
    "rtl:",
    "  sources:",
    ...rtlGlobs.map((g) => `    - "${g}"`),
    "testbench:",
    "  sources:",
    ...tbFiles.map((f) => `    - ${f}`),
    `  top: ${top}${r.testbenchCandidates.length === 1 ? "" : "   # TODO: confirm"}`,
    "simulator:",
    "  engine: verilator",
    "  timing: true",
    "  assertions: true",
    "  coverage: true",
    "regressions:",
    "  smoke:",
    "    tests: [smoke]",
    "resources:",
    "  cpu: 1",
    "  memory_mb: 2048",
    "  timeout_seconds: 300",
    "",
  ].join("\n");
  return r;
}
