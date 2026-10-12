// Evaluation of the rule-based failure analyzer on a labeled set of seeded
// defects. Each case is the demo design (with the reference fix applied, so
// the unmodified design passes) plus ONE injected defect whose location is
// known. Every case runs as a real regression (real Verilator in the Docker
// sandbox, real worker, real API) and every failing test task is analyzed
// through the public API. Scoring per analysis:
//   correct    — a root cause is asserted AND a cited location is within
//                ±2 lines of the injected defect
//   abstained  — "insufficient evidence" (no root cause claimed)
//   wrong      — a root cause is asserted but no cited location is near the
//                defect (a false positive diagnosis)
//   localized  — independent of the claim: a cited location is near the defect
// Plus detection by the testbench (a defect no test catches is a false
// negative of the test suite, not of the analyzer) and a clean baseline.
//   npx tsx bench/ai-eval.ts   (writes docs/benchmarks/ai-eval.json)
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

import { applyFilePatch, parseUnifiedDiff } from "@verifycloud/shared";

import { createTestDatabase, DEMO_DIR, orgWithProject, snapshotOf, startServer, uploadSnapshot } from "../packages/server/test/helpers.js";
import { startWorker } from "../packages/worker/src/main.js";
import { environment } from "./env.js";

const RTL = "rtl/axil_regs.sv";
const demo: Record<string, string> = {};
const walk = (d: string) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else demo[relative(DEMO_DIR, p)] = readFileSync(p, "utf8");
  }
};
walk(DEMO_DIR);
const original = demo[RTL]!;
const fixed = (() => {
  const [fp] = parseUnifiedDiff(readFileSync(join(DEMO_DIR, "fix-rdata-stable.patch"), "utf8"));
  const r = applyFilePatch(original, fp!);
  if (r === null) throw new Error("reference fix does not apply");
  return r;
})();

interface Case { name: string; category: string; desc: string; rtl: string; lines: number[] }
const lineOf = (src: string, needle: string) => src.slice(0, src.indexOf(needle)).split("\n").length;
function mutant(name: string, category: string, desc: string, oldS: string, newS: string, base = fixed): Case {
  if (base.split(oldS).length !== 2) throw new Error(`${name}: anchor not unique`);
  const rtl = base.replace(oldS, newS);
  return { name, category, desc, rtl, lines: [lineOf(rtl, newS)] };
}
const CASES: Case[] = [
  { name: "original_demo_bug", category: "protocol/stability", desc: "RDATA decoded from the live ARADDR (the shipped intentional bug)", rtl: original, lines: [lineOf(original, "read_reg(araddr);")] },
  mutant("strobe_ignored", "datapath", "write strobes ignored (full-word write)", "r[8*b +: 8] = strb[b] ? data[8*b +: 8] : old[8*b +: 8];", "r[8*b +: 8] = data[8*b +: 8];"),
  mutant("strobe_swapped", "datapath", "byte lanes of WSTRB reversed", "strb[b] ? data", "strb[3-b] ? data"),
  mutant("id_writable", "decode/response", "write to ID returns OKAY instead of SLVERR", "bresp <= SLVERR;\n        end", "bresp <= (aw_addr_q == 8'h10) ? OKAY : SLVERR;\n        end"),
  mutant("unaligned_ok", "decode/response", "unaligned read returns OKAY", "if (a[1:0] != 2'b00)            return {SLVERR, 32'h0};", "if (1'b0)                       return {SLVERR, 32'h0};"),
  mutant("scratch_reset", "reset", "SCRATCH reset value wrong", "regs[3] <= 32'hA5A5_0000;", "regs[3] <= 32'h0;"),
  mutant("bvalid_drop", "protocol/handshake", "BVALID dropped without BREADY", "if (bvalid && bready) bvalid <= 1'b0;", "if (bvalid) bvalid <= 1'b0;"),
  mutant("rvalid_drop", "protocol/handshake", "RVALID dropped without RREADY", "end else if (rvalid && rready) begin", "end else if (rvalid) begin"),
  mutant("decode_alias", "decode/response", "read decode ignores address bit 3", "return {OKAY, regs[a[3:2]]};", "return {OKAY, regs[{1'b0, a[2]}]};"),
  mutant("write_wrong_reg", "datapath", "write to DATA1 (0x08) lands in DATA0 (0x04)", "regs[aw_addr_q[3:2]] <= apply_strobe(regs[aw_addr_q[3:2]]", "regs[aw_addr_q[3:2] == 2'd2 ? 2'd1 : aw_addr_q[3:2]] <= apply_strobe(regs[aw_addr_q[3:2]]"),
  mutant("awready_ungated", "protocol/handshake", "AWREADY not gated by the held address", "assign awready = !aw_held && !bvalid;", "assign awready = !bvalid;"),
  mutant("syntax_error", "build", "missing semicolon", "assign arready = !rvalid;", "assign arready = !rvalid"),
];

const near = (locs: { file: string; line: number }[], c: Case) => locs.some((l) => l.file === RTL && c.lines.some((x) => Math.abs(l.line - x) <= 2));

async function main() {
  const db = await createTestDatabase();
  const s = await startServer(db.url, { limits: { jobCreatePerMinute: 1000 } } as any);
  const worker = await startWorker({ apiUrl: s.base, name: "ai-eval", sandbox: "docker", simImage: process.env.SIM_IMAGE ?? "verifycloud-sim:verilator", cpus: 2, memoryMb: 6144, pollIntervalMs: 200, workDir: join(tmpdir(), `vc-ai-eval-${process.pid}`) });
  const o = await orgWithProject(s.base, "aieval");
  const run = async (rtl: string) => {
    await uploadSnapshot(o.c, o.project.id, snapshotOf({ ...demo, [RTL]: rtl }));
    const job = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "full" })).json.job;
    for (const t0 = Date.now(); ; ) {
      const j = (await o.c.get(`/api/v1/jobs/${job.id}`)).json.job;
      if (!["QUEUED", "RUNNING"].includes(j.state)) break;
      if (Date.now() - t0 > 900_000) throw new Error("job did not finish");
      await new Promise((r) => setTimeout(r, 500));
    }
    return (await o.c.get(`/api/v1/jobs/${job.id}/tasks`)).json.tasks as any[];
  };

  const out: any = { environment: environment(), generatedAt: new Date().toISOString(), baseline: null, cases: [] };
  const base = await run(fixed);
  out.baseline = { tasks: base.length, failing: base.filter((t) => !["PASSED"].includes(t.state)).map((t) => `${t.kind}:${t.test_name ?? ""}:${t.seed ?? ""}:${t.state}`) };
  console.log("baseline", out.baseline);

  for (const c of CASES) {
    const tasks = await run(c.rtl);
    const failing = tasks.filter((t) => t.state !== "PASSED" && t.state !== "SKIPPED" && t.state !== "CANCELLED");
    // one analysis per failing test name (seeds of the same test share a cause)
    const picked = new Map<string, any>();
    for (const t of failing) if (!picked.has(`${t.kind}:${t.test_name}`)) picked.set(`${t.kind}:${t.test_name}`, t);
    const analyses = [];
    for (const t of picked.values()) {
      const a = (await o.c.post(`/api/v1/tasks/${t.id}/analyze`)).json.analysis;
      const r = a?.result;
      const verdict = !r ? "error" : r.insufficientEvidence ? "abstained" : near(r.locations, c) ? "correct" : "wrong";
      analyses.push({
        task: `${t.kind}:${t.test_name ?? ""}:${t.seed ?? ""}`,
        state: t.state,
        verdict,
        localized: !!r && near(r.locations, c),
        confidence: r?.confidence ?? null,
        summary: r?.summary ?? a?.error ?? null,
        rootCause: r?.rootCause ?? null,
        locations: (r?.locations ?? []).map((l: any) => `${l.file}:${l.line}${l.verified ? "" : " (unverified)"}`),
      });
    }
    const rec = { name: c.name, category: c.category, desc: c.desc, defectLines: c.lines, detected: failing.length > 0, failingTasks: failing.map((t) => `${t.kind}:${t.test_name ?? ""}:${t.seed ?? ""}:${t.state}`), analyses };
    out.cases.push(rec);
    console.log(c.name, rec.detected ? "detected" : "NOT DETECTED", analyses.map((a) => `${a.task}=${a.verdict}`).join(" "));
  }
  const all = out.cases.flatMap((c: any) => c.analyses);
  const count = (v: string) => all.filter((a: any) => a.verdict === v).length;
  out.summary = {
    cases: CASES.length,
    detectedByTests: out.cases.filter((c: any) => c.detected).length,
    analyses: all.length,
    correct: count("correct"),
    abstained: count("abstained"),
    wrong: count("wrong"),
    errors: count("error"),
    localized: all.filter((a: any) => a.localized).length,
    casesWithAtLeastOneCorrect: out.cases.filter((c: any) => c.analyses.some((a: any) => a.verdict === "correct")).length,
    highConfidenceWrong: all.filter((a: any) => a.verdict === "wrong" && a.confidence === "high").length,
  };
  console.log(out.summary);
  writeFileSync(process.env.AI_EVAL_OUT ?? "docs/benchmarks/ai-eval.json", JSON.stringify(out, null, 2) + "\n");
  await worker.stop();
  await s.app.close();
  await db.drop();
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
