// Unit and property tests of the shared domain logic.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  applyFilePatch,
  assertionSignals,
  buildIndex,
  changesInRange,
  coverageDelta,
  detectProject,
  expandRegression,
  mergeCoverage,
  parseConfig,
  parseUnifiedDiff,
  parseVcd,
  redact,
  safeRelativePattern,
  summarize,
  tarFiles,
  validateConfig,
  valueAt,
  type CoverageDetail,
} from "../src/index.js";

const base = `version: 1
project: { name: demo }
rtl: { sources: ["rtl/**/*.sv"] }
testbench: { sources: [tb/tb.sv], top: tb }
simulator: { engine: verilator }
tests:
  a: { seeds: { range: [1, 3] } }
regressions:
  smoke: { tests: [a, b] }
`;

describe("verifycloud.yaml", () => {
  it("parses and expands a regression deterministically", () => {
    const c = parseConfig(base);
    const runs = expandRegression(c, "smoke");
    expect(runs.map((r) => `${r.test}:${r.seed}`)).toEqual(["a:1", "a:2", "a:3", "b:1"]);
    expect(runs[0]!.plusargs).toEqual({ TEST: "a", SEED: "1" });
  });

  it("reports every problem with a line number, never guesses", () => {
    const r = validateConfig(base.replace("engine: verilator", "engine: vcs, flags: [-Mdir=/etc, --exe]") + "extra: 1\n");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const msgs = r.issues.map((i) => `${i.line}:${i.path}`);
    expect(msgs).toContain("10:extra");
    expect(r.issues.some((i) => i.path === "simulator.engine" && i.line === 5)).toBe(true);
    expect(r.issues.filter((i) => i.path.startsWith("simulator.flags")).length).toBe(2);
  });

  it("rejects path traversal, absolute paths and seed plusarg overrides", () => {
    for (const bad of ["../x.sv", "/etc/passwd", "a/../../b", "C:/x"]) expect(safeRelativePattern(bad)).toBe(false);
    const r = validateConfig(base.replace('"rtl/**/*.sv"', '"../secret/*.sv"').replace("a: { seeds", "a: { plusargs: { SEED: '5' }, seeds"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.message.includes(".."))).toBe(true);
      expect(r.issues.some((i) => i.message.includes("set from the test's seeds"))).toBe(true);
    }
  });

  it("requires the essential sections", () => {
    const r = validateConfig("version: 1\nproject: { name: x }\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.message).join(" ")).toMatch(/rtl.sources is required/);
  });

  it("never throws anything but a validation result on arbitrary input (fuzz)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (s) => {
        const r = validateConfig(s);
        expect(typeof r.ok).toBe("boolean");
      }),
      { numRuns: 2000 },
    );
  });
});

describe("redaction", () => {
  it("removes known secrets and common credential formats", () => {
    const r = redact("token ghp_" + "a".repeat(36) + " url https://u:p4ss@host/x key=AKIAABCDEFGHIJKLMNOP mine:supersecret", ["supersecret"]);
    expect(r.text).not.toMatch(/ghp_a|p4ss|AKIA|supersecret/);
    expect(r.count).toBe(4);
  });
});

describe("unified diff", () => {
  const src = "a\nb\nc\nd\n";
  const diff = "--- a/f.sv\n+++ b/f.sv\n@@ -2,2 +2,2 @@\n b\n-c\n+C\n";
  it("applies exactly and refuses when the context does not match", () => {
    const [fp] = parseUnifiedDiff(diff);
    expect(applyFilePatch(src, fp!)).toBe("a\nb\nC\nd\n");
    expect(() => applyFilePatch("a\nx\nc\nd\n", fp!)).toThrow(/does not apply/);
  });
  it("rejects unsafe paths and inconsistent hunks", () => {
    expect(() => parseUnifiedDiff("--- a/../f\n+++ b/../f\n@@ -1 +1 @@\n-a\n+b\n")).toThrow(/unsafe/);
    expect(() => parseUnifiedDiff("--- a/f\n+++ b/f\n@@ -1,3 +1,1 @@\n-a\n+b\n")).toThrow(/inconsistent/);
  });
});

describe("SystemVerilog index (partial parser)", () => {
  const sv = `module m(input logic clk, input logic [3:0] a, output logic [3:0] y);
  // comment with module fake;
  always_comb begin
    y = a + 1;
  end
  chk: assert property (@(posedge clk) a != 0 |-> $stable(y)) else $error("x");
  sub u_sub (.clk(clk));
endmodule`;
  it("finds modules, ports, assertions, instances and drivers", () => {
    const idx = buildIndex([{ path: "m.sv", content: sv }]);
    expect(idx.symbols.filter((s) => s.kind === "module").map((s) => s.name)).toEqual(["m"]);
    expect(idx.symbols.find((s) => s.kind === "assertion")?.name).toBe("chk");
    expect(idx.symbols.find((s) => s.kind === "instance")).toMatchObject({ name: "u_sub", detail: "sub" });
    expect(idx.assignments.find((a) => a.target === "y")).toMatchObject({ context: "always_comb", rhsIdentifiers: ["a"] });
    expect(assertionSignals(idx.symbols.find((s) => s.kind === "assertion")!.detail!).stable).toEqual(["y"]);
  });
});

describe("VCD index", () => {
  const vcd = `$timescale 1ps $end
$scope module top $end
$var wire 1 ! clk $end
$var wire 4 " d [3:0] $end
$upscope $end
$enddefinitions $end
#0
0!
b0000 "
#5
1!
#10
0!
b1010 "
#15
1!
#20
0!
#25
1!
#30
0!
#35
1!
`;
  it("parses hierarchy and value changes and answers point queries", () => {
    const w = parseVcd(vcd);
    expect(w.signals.map((s) => s.name)).toEqual(["top.clk", "top.d"]);
    expect(w.clockPeriod).toBe(10);
    expect(valueAt(w.changes[1], 9)).toBe("0000");
    expect(valueAt(w.changes[1], 10)).toBe("1010");
    expect(changesInRange(w.changes[1], 0, 20)).toEqual([[0, "0000"], [10, "1010"]]);
  });
  it("bounds memory with a change limit", () => {
    expect(parseVcd(vcd, { maxSignals: 10, maxChanges: 3 }).truncated).toBe(true);
  });
});

describe("coverage", () => {
  const d = (counts: number[]): CoverageDetail => ({ version: 1, tool: "t", files: ["a.sv"], points: counts.map((c, i) => [0, i + 1, "line", c, String(i)]) });
  it("merges by point and summarizes", () => {
    const m = mergeCoverage([d([1, 0, 0]), d([0, 2, 0])]);
    expect(summarize(m).line).toEqual({ covered: 2, total: 3 });
  });
  it("merge is commutative and covered-ness is the union (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.array(fc.nat(3), { minLength: 5, maxLength: 5 }), { minLength: 1, maxLength: 6 }), (sets) => {
        const ds = sets.map(d);
        const a = summarize(mergeCoverage(ds));
        const b = summarize(mergeCoverage([...ds].reverse()));
        expect(a).toEqual(b);
        const union = [0, 1, 2, 3, 4].filter((i) => sets.some((s) => s[i]! > 0)).length;
        expect(a.line!.covered).toBe(union);
      }),
    );
  });
  it("reports deltas only for metrics present in both runs", () => {
    expect(coverageDelta({ line: { covered: 943, total: 1000 }, toggle: { covered: 1, total: 2 } }, { line: { covered: 921, total: 1000 } })).toEqual({ line: { previous: 94.3, current: 92.1, delta: -2.2 } });
  });
});

describe("detection and tarball", () => {
  it("proposes a configuration and lists open questions", () => {
    const r = detectProject([
      { path: "rtl/core.sv", content: "module core(input logic clk); endmodule" },
      { path: "tb/tb_core.sv", content: "module tb_core;\n core u(.clk());\nendmodule" },
      { path: "Makefile" },
    ]);
    expect(r.testbenchCandidates).toEqual(["tb_core"]);
    expect(r.proposedConfig).toContain("top: tb_core");
    expect(validateConfig(r.proposedConfig!).ok).toBe(true);
  });
  it("writes deterministic archives with long paths", () => {
    const files = [{ path: `${"d".repeat(120)}/f.sv`, content: Buffer.from("x") }, { path: "a.sv", content: Buffer.from("y") }];
    expect(tarFiles(files).equals(tarFiles([...files].reverse()))).toBe(true);
  });
});
