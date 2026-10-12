// Coverage data model shared by the worker (producer) and the server (merge,
// history, comparison). Only metric types the simulator actually reported
// appear; nothing is estimated or synthesized.
import type { CoverageSummary } from "./types.js";

export type CoverageType = "line" | "branch" | "toggle" | "functional";

/** Per-test coverage detail: one row per coverage point. */
export interface CoverageDetail {
  version: 1;
  tool: string;               // e.g. "verilator 5.020"
  files: string[];
  // [fileIndex, line, type, count, label]; label distinguishes points on one line
  points: [number, number, CoverageType, number, string][];
}

export function summarize(d: CoverageDetail): CoverageSummary {
  const s: CoverageSummary = {};
  for (const [, , type, count] of d.points) {
    const m = (s[type] ??= { covered: 0, total: 0 });
    m.total++;
    if (count > 0) m.covered++;
  }
  return s;
}

/** Union of coverage points across tests (counts are summed). */
export function mergeCoverage(details: CoverageDetail[]): CoverageDetail {
  const files: string[] = [];
  const fileIdx = new Map<string, number>();
  const points = new Map<string, [number, number, CoverageType, number, string]>();
  for (const d of details) {
    for (const [fi, line, type, count, label] of d.points) {
      const file = d.files[fi] ?? "?";
      let idx = fileIdx.get(file);
      if (idx === undefined) {
        idx = files.push(file) - 1;
        fileIdx.set(file, idx);
      }
      const k = `${file}\0${line}\0${type}\0${label}`;
      const cur = points.get(k);
      if (cur) cur[3] += count;
      else points.set(k, [idx, line, type, count, label]);
    }
  }
  return { version: 1, tool: details[0]?.tool ?? "", files, points: [...points.values()] };
}

export interface FileCoverage {
  file: string;
  metrics: CoverageSummary;
  uncoveredLines: number[]; // lines with at least one uncovered line/branch point
}

export function perFile(d: CoverageDetail): FileCoverage[] {
  const by = new Map<number, FileCoverage>();
  for (const [fi, line, type, count] of d.points) {
    let f = by.get(fi);
    if (!f) by.set(fi, (f = { file: d.files[fi] ?? "?", metrics: {}, uncoveredLines: [] }));
    const m = (f.metrics[type] ??= { covered: 0, total: 0 });
    m.total++;
    if (count > 0) m.covered++;
    else if ((type === "line" || type === "branch") && !f.uncoveredLines.includes(line)) f.uncoveredLines.push(line);
  }
  for (const f of by.values()) f.uncoveredLines.sort((a, b) => a - b);
  return [...by.values()].sort((a, b) => a.file.localeCompare(b.file));
}

export function functionalPoints(d: CoverageDetail): { name: string; file: string; line: number; count: number }[] {
  return d.points.filter((p) => p[2] === "functional").map(([fi, line, , count, label]) => ({ name: label, file: d.files[fi] ?? "?", line, count }));
}

/** Percentage-point delta per metric between two summaries (only metrics present in both). */
export function coverageDelta(prev: CoverageSummary | null | undefined, cur: CoverageSummary | null | undefined) {
  const out: Partial<Record<CoverageType, { previous: number; current: number; delta: number }>> = {};
  if (!prev || !cur) return out;
  for (const t of ["line", "branch", "toggle", "functional"] as CoverageType[]) {
    const a = prev[t];
    const b = cur[t];
    if (a && b && a.total > 0 && b.total > 0) {
      const p = (100 * a.covered) / a.total;
      const c = (100 * b.covered) / b.total;
      out[t] = { previous: round1(p), current: round1(c), delta: round1(c - p) };
    }
  }
  return out;
}
const round1 = (x: number) => Math.round(x * 10) / 10;
