// Regression tests for defects found in the 2026-10-08 audit (no Docker needed).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { forbiddenFlag, validateConfig } from "@verifycloud/shared";
import { describe, expect, it } from "vitest";

import { VerilatorAdapter } from "../src/adapters/verilator.js";
import { boundedDirUsage, readUntrusted } from "../src/safefs.js";
import { OutputCollector } from "../src/sandbox.js";
import { cacheKey, resolveSources } from "../src/sources.js";

const dir = () => mkdtempSync(join(tmpdir(), "vc-audit-"));

describe("reading untrusted sandbox output (C1, C2)", () => {
  it("refuses symlinks, FIFOs and oversized files, reads regular files", () => {
    const d = dir();
    writeFileSync(join(d, "secret"), "HOST-SECRET");
    symlinkSync(join(d, "secret"), join(d, "link"));
    execFileSync("mkfifo", [join(d, "fifo")]);
    writeFileSync(join(d, "big"), Buffer.alloc(2048));
    writeFileSync(join(d, "ok"), "data");
    const link = readUntrusted(join(d, "link"), 1 << 20);
    expect(link.ok).toBe(false);
    const fifo = readUntrusted(join(d, "fifo"), 1 << 20); // must return, not block
    expect(fifo.ok).toBe(false);
    expect(readUntrusted(join(d, "big"), 1024).ok).toBe(false);
    expect(readUntrusted(join(d, "missing"), 1024)).toEqual({ ok: false, reason: "missing" });
    const ok = readUntrusted(join(d, "ok"), 1024);
    expect(ok.ok && ok.data.toString()).toBe("data");
  });

  it("bounds the work of scanning an adversarial output tree", () => {
    const d = dir();
    for (let i = 0; i < 200; i++) writeFileSync(join(d, `f${i}`), "");
    expect(boundedDirUsage(d, { maxEntries: 100, maxDepth: 8 }).exceeded).toMatch(/more than 100 files/);
    let p = d;
    for (let i = 0; i < 12; i++) mkdirSync((p = join(p, "x")));
    const deep = mkdtempSync(join(tmpdir(), "vc-audit-deep-"));
    let q = deep;
    for (let i = 0; i < 12; i++) mkdirSync((q = join(q, "x")));
    expect(boundedDirUsage(deep, { maxEntries: 1000, maxDepth: 8 }).exceeded).toMatch(/deeper than 8/);
  });
});

describe("output collection (M7, M8)", () => {
  it("keeps the tail so the harness verdict of a long passing run is not lost, and strips NUL", () => {
    const c = new OutputCollector(1024);
    c.push(Buffer.alloc(5 * 1024 * 1024, "a"), "out");
    c.push(Buffer.from("x\u0000y\nVC_SIM_END finish=1 error=0 time=10 timeunit=-12\n"), "out");
    const t = c.text();
    expect(t).toContain("VC_SIM_END finish=1 error=0");
    expect(t).not.toContain("\u0000");
    expect(t).toMatch(/bytes of output omitted/);
    expect(c.dropped).toBeGreaterThan(5_000_000);
    const parsed = new VerilatorAdapter().parseRun(t, 0);
    expect(parsed.passed).toBe(true);
  });
});

describe("pass/fail decision", () => {
  it("a self-check failure fails the run even if the testbench finishes cleanly", () => {
    const log = "VC_CHECK FAIL read data mismatch\n- tb.sv:9: Verilog $finish\nVC_SIM_END finish=1 error=0 time=100 timeunit=-12\n";
    const r = new VerilatorAdapter().parseRun(log, 0);
    expect(r.passed).toBe(false);
    expect(r.summary).toMatch(/self-check failed/);
  });
});

describe("simulator flag deny-list (H8)", () => {
  it("rejects single-dash spellings and file-pulling flags", () => {
    for (const f of ["--binary", "-binary", "-main", "--main", "-top", "-top-module=x", "-Mdir", "--Mdir=x", "-o", "-f", "-F", "-y", "-v", "+incdir+/etc", "-I/etc", "-CFLAGS", "--cflags=-O0", "-LDFLAGS", "-no-timing", "--no-assert", "-exe", "-build", "--compiler", "+libext+.v"])
      expect(forbiddenFlag(f), f).toBe(true);
    for (const f of ["-Wno-WIDTH", "-Wall", "-O3", "--x-assign=fast", "-DFOO=1", "--unroll-count=64"]) expect(forbiddenFlag(f), f).toBe(false);
  });

  it("reserves vc_* plusargs (they would override the harness output paths)", () => {
    const cfg = `version: 1
project: { name: p }
rtl: { sources: ["rtl/*.sv"] }
testbench: { sources: ["tb/*.sv"], top: tb }
simulator: { engine: verilator }
tests:
  t: { plusargs: { vc_trace: "/work/src/x" } }
regressions:
  r: { tests: [t] }
`;
    const v = validateConfig(cfg);
    expect(v.ok).toBe(false);
    expect(JSON.stringify(v)).toMatch(/reserved/);
  });
});

describe("build cache key (H7)", () => {
  it("changes when a file outside the source globs (an `include header) changes", () => {
    const cfg = validateConfig(`version: 1
project: { name: p }
rtl: { sources: ["rtl/*.sv"] }
testbench: { sources: ["tb/*.sv"], top: tb }
simulator: { engine: verilator }
tests: { t: {} }
regressions: { r: { tests: [t] } }
`);
    if (!cfg.ok) throw new Error("config");
    const mk = (hdr: string) => {
      const d = dir();
      mkdirSync(join(d, "rtl"));
      mkdirSync(join(d, "tb"));
      mkdirSync(join(d, "inc"));
      writeFileSync(join(d, "rtl/a.sv"), '`include "inc/defs.svh"\nmodule a; endmodule\n');
      writeFileSync(join(d, "tb/tb.sv"), "module tb; a u(); endmodule\n");
      writeFileSync(join(d, "inc/defs.svh"), hdr);
      return cacheKey({ m: 1 }, resolveSources(d, cfg.config));
    };
    expect(mk("`define W 8\n")).not.toBe(mk("`define W 16\n"));
  });
});
