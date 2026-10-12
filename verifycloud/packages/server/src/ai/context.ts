// Controlled context for failure analysis.
//
// The context is assembled from evidence VerifyCloud already holds for the
// failing task — never "the whole repository":
//   test identity (name, seed, plusargs, state), the relevant part of the log,
//   assertion failures, the assertion's source, the RTL that drives the
//   signals the assertion checks, the recent diff against the previous
//   passing run (when available), the patch under test (patch jobs), and
//   waveform values around the failure time (when a waveform was recorded).
// Every piece is size-limited and secret-redacted; a manifest records exactly
// what was included so the user can see what would be / was sent.
import { gunzipSync } from "node:zlib";

import { assertionSignals, buildIndex, redact, type SvIndex } from "@verifycloud/shared";

import type { Ctx } from "../app.js";
import { decryptSecret } from "../crypto.js";
import { readSnapshotFiles } from "../snapshot.js";
import { loadWaveIndex, valuesInWindow } from "../waveform.js";

export interface ContextFile {
  path: string;
  startLine: number;
  endLine: number;
  text: string; // numbered lines, redacted
  reason: string;
}

export interface FailureContext {
  task: { id: string; kind: string; test: string | null; seed: number | null; state: string; plusargs: Record<string, string>; exitCode: number | null; durationMs: number | null; timeoutSeconds: number };
  job: { id: string; number: number; regression: string; commit: string | null; branch: string | null; simulator: string };
  summary: string | null;
  checkFailures: string[];
  assertions: { name: string; scope: string; message: string; file: string; line: number; simTime: string | null; property?: string; signals?: ReturnType<typeof assertionSignals> }[];
  diagnostics: { severity: string; file: string | null; line: number | null; message: string }[];
  logExcerpt: string;
  files: ContextFile[];
  drivers: { signal: string; file: string; line: number; context: string; text: string; rhs: string[]; container?: string }[];
  diff: string | null;
  patch: string | null;
  waveform: { signals: string[]; rows: string } | null;
  manifest: { item: string; bytes: number }[];
  redactions: { count: number; kinds: string[] };
  fileLineCounts: Record<string, number>; // for validating cited locations
  index: SvIndex | null;
}

const HDL = /\.(sv|svh|v|vh)$/i;
const numbered = (lines: string[], start: number) => lines.map((l, i) => `${String(start + i).padStart(5)}| ${l}`).join("\n");

function excerpt(content: string, line: number, before: number, after: number) {
  const lines = content.split("\n");
  const s = Math.max(1, line - before);
  const e = Math.min(lines.length, line + after);
  return { startLine: s, endLine: e, text: numbered(lines.slice(s - 1, e), s) };
}

/** Minimal line diff (LCS) for small files, unified-like output. */
export function lineDiff(a: string, b: string, path: string, maxLines = 400): string {
  const x = a.split("\n");
  const y = b.split("\n");
  if (x.length * y.length > 4_000_000) return `--- a/${path}\n+++ b/${path}\n(file too large to diff)\n`;
  const dp: number[][] = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      i++;
      j++;
    } else if (j < y.length && (i >= x.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) out.push(`+${j + 1}: ${y[j++]}`);
    else out.push(`-${i + 1}: ${x[i++]}`);
    if (out.length > maxLines) {
      out.push("… (diff truncated)");
      break;
    }
  }
  return out.length > 2 ? out.join("\n") : "";
}

export async function buildFailureContext(ctx: Ctx, taskId: string, maxBytes: number): Promise<FailureContext> {
  const { db, store } = ctx;
  const t = (await db.query("SELECT * FROM tasks WHERE id = $1", [taskId])).rows[0];
  const j = (await db.query("SELECT * FROM jobs WHERE id = $1", [t.job_id])).rows[0];
  const secrets = (await db.query("SELECT ciphertext, nonce FROM project_secrets WHERE project_id = $1", [t.project_id])).rows.map((r) => {
    try {
      return decryptSecret(ctx.cfg.secretKey, r.ciphertext, r.nonce);
    } catch {
      return "";
    }
  });
  let redCount = 0;
  const redKinds = new Set<string>();
  const R = (s: string) => {
    const r = redact(s, secrets);
    redCount += r.count;
    r.kinds.forEach((k) => redKinds.add(k));
    return r.text;
  };
  const manifest: FailureContext["manifest"] = [];
  let budget = maxBytes;
  const take = (item: string, s: string) => {
    const cut = s.length > budget ? s.slice(0, Math.max(0, budget)) + "\n… (truncated to fit the context limit)" : s;
    budget -= cut.length;
    manifest.push({ item, bytes: cut.length });
    return cut;
  };

  const result = t.result ?? {};
  const assertions = (await db.query("SELECT * FROM assertion_failures WHERE task_id = $1 ORDER BY id LIMIT 10", [taskId])).rows;

  // log: the lines around the first error/assertion and the tail
  let logExcerpt = "";
  const logArt = (await db.query("SELECT storage_key, encoding FROM artifacts WHERE task_id = $1 AND kind = 'log' ORDER BY created_at DESC LIMIT 1", [taskId])).rows[0];
  if (logArt) {
    let raw = await store.getBuffer(logArt.storage_key, 64 * 1024 * 1024);
    if (logArt.encoding === "gzip") raw = gunzipSync(raw, { maxOutputLength: 256 * 1024 * 1024 });
    const lines = raw.toString("utf8").split("\n");
    const first = lines.findIndex((l) => /%Error|%Fatal|Assertion failed|VC_CHECK FAIL|VC_RESULT FAIL|error:/i.test(l));
    const parts: string[] = [];
    if (first >= 0) parts.push(...lines.slice(Math.max(0, first - 15), first + 25));
    parts.push("…", ...lines.slice(-30));
    logExcerpt = take("log excerpt", R(parts.join("\n")));
  }

  // sources from the snapshot
  const files: ContextFile[] = [];
  const fileLineCounts: Record<string, number> = {};
  let index: SvIndex | null = null;
  let drivers: FailureContext["drivers"] = [];
  let diff: string | null = null;
  const srcArtId = j.source?.artifactId;
  let sources = new Map<string, string>();
  if (srcArtId) {
    const a = (await db.query("SELECT storage_key FROM artifacts WHERE id = $1 AND org_id = $2", [srcArtId, t.org_id])).rows[0];
    if (a) {
      sources = await readSnapshotFiles(await store.getBuffer(a.storage_key, 256 * 1024 * 1024), (p) => HDL.test(p), 2 * 1024 * 1024, 32 * 1024 * 1024);
      for (const [p, c] of sources) fileLineCounts[p] = c.split("\n").length;
      index = buildIndex([...sources].map(([path, content]) => ({ path, content })));
    }
  }
  const assertionInfo: FailureContext["assertions"] = [];
  for (const a of assertions) {
    const sym = index?.symbols.find((s) => (s.kind === "assertion" || s.kind === "cover") && s.file.endsWith(a.file.split("/").pop()!) && Math.abs(s.line - a.line) <= 3);
    const signals = sym?.detail ? assertionSignals(sym.detail) : undefined;
    assertionInfo.push({ name: a.name, scope: a.scope, message: R(a.message), file: sym?.file ?? a.file, line: a.line, simTime: a.sim_time, property: sym?.detail, signals });
    const src = sym ? sources.get(sym.file) : undefined;
    if (src && !files.some((f) => f.path === sym!.file)) {
      const e = excerpt(src, sym!.line, 6, 6);
      files.push({ path: sym!.file, ...e, text: take(`source ${sym!.file}:${e.startLine}-${e.endLine}`, R(e.text)), reason: `assertion ${a.name}` });
    }
    // RTL that drives the checked signals
    for (const sig of signals?.consequent ?? []) {
      for (const d of (index?.assignments ?? []).filter((x) => x.target === sig && !/^tb\//.test(x.file) && x.context !== "initial").slice(0, 3)) {
        if (!drivers.some((x) => x.signal === sig && x.file === d.file && x.line === d.line))
          drivers.push({ signal: sig, file: d.file, line: d.line, context: d.context, text: d.text, rhs: d.rhsIdentifiers, container: d.container });
        const content = sources.get(d.file);
        if (content && !files.some((f) => f.path === d.file && d.line >= f.startLine && d.line <= f.endLine)) {
          const e = excerpt(content, d.line, 25, 8);
          files.push({ path: d.file, ...e, text: take(`source ${d.file}:${e.startLine}-${e.endLine}`, R(e.text)), reason: `drives ${sig}` });
        }
      }
    }
  }
  // build failures: excerpts around compiler diagnostics
  const diagnostics: FailureContext["diagnostics"] = (result.diagnostics ?? []).slice(0, 20);
  for (const d of diagnostics.filter((d) => d.file && d.line && d.severity === "error").slice(0, 3)) {
    const key = [...sources.keys()].find((p) => p === d.file || p.endsWith("/" + d.file) || d.file!.endsWith(p));
    if (key && !files.some((f) => f.path === key)) {
      const e = excerpt(sources.get(key)!, d.line!, 10, 10);
      files.push({ path: key, ...e, text: take(`source ${key}:${e.startLine}-${e.endLine}`, R(e.text)), reason: "compiler diagnostic" });
    }
  }
  drivers = drivers.slice(0, 10);

  // recent diff: HDL changes since the previous passing job of this branch
  const prev = (
    await db.query(
      "SELECT source FROM jobs WHERE project_id = $1 AND regression = $2 AND branch IS NOT DISTINCT FROM $3 AND state = 'SUCCEEDED' AND created_at < $4 ORDER BY created_at DESC LIMIT 1",
      [j.project_id, j.regression, j.branch, j.created_at],
    )
  ).rows[0];
  if (prev?.source?.artifactId && sources.size) {
    const a = (await db.query("SELECT storage_key FROM artifacts WHERE id = $1 AND org_id = $2", [prev.source.artifactId, t.org_id])).rows[0];
    if (a) {
      const old = await readSnapshotFiles(await store.getBuffer(a.storage_key, 256 * 1024 * 1024), (p) => HDL.test(p), 2 * 1024 * 1024, 32 * 1024 * 1024);
      const parts: string[] = [];
      for (const [p, c] of sources) {
        const o = old.get(p);
        if (o === undefined) parts.push(`+++ new file ${p}`);
        else if (o !== c) parts.push(lineDiff(o, c, p));
      }
      if (parts.length) diff = take("diff vs. previous passing run", R(parts.join("\n")));
    }
  }
  let patch: string | null = null;
  if (j.patch_id) {
    const p = (await db.query("SELECT diff FROM patches WHERE id = $1", [j.patch_id])).rows[0];
    if (p) patch = take("patch under test", R(p.diff));
  }

  // waveform values around the first assertion failure
  let waveform: FailureContext["waveform"] = null;
  const first = assertionInfo[0];
  const wIdx = (await db.query("SELECT id, storage_key FROM artifacts WHERE task_id = $1 AND kind = 'waveform_index' LIMIT 1", [taskId])).rows[0];
  if (wIdx && first?.simTime && first.signals) {
    try {
      const w = await loadWaveIndex(ctx, wIdx.id, wIdx.storage_key);
      const t1 = BigInt(first.simTime);
      const span = BigInt(w.clockPeriod ?? 20) * 4n;
      const wanted = [...new Set([...first.signals.all, ...drivers.flatMap((d) => d.rhs)])];
      const rows = valuesInWindow(w, wanted, t1 > span ? t1 - span : 0n, t1 + BigInt(w.clockPeriod ?? 20));
      if (rows.signals.length) waveform = { signals: rows.signals, rows: take("waveform window", rows.table) };
    } catch (e) {
      ctx.log.warn({ err: (e as Error).message }, "waveform context unavailable");
    }
  }

  const cfg = j.config ?? {};
  return {
    task: { id: t.id, kind: t.kind, test: t.test_name, seed: t.seed === null ? null : Number(t.seed), state: t.state, plusargs: t.plusargs, exitCode: t.exit_code, durationMs: t.duration_ms, timeoutSeconds: t.timeout_seconds },
    job: { id: j.id, number: j.number, regression: j.regression, commit: j.commit_sha, branch: j.branch, simulator: `${cfg.simulator?.engine ?? "?"} ${j.toolchain?.simulatorVersion ?? ""}`.trim() },
    summary: result.summary ? R(String(result.summary)) : null,
    checkFailures: (result.checkFailures ?? []).slice(0, 10).map((s: string) => R(s)),
    assertions: assertionInfo,
    diagnostics,
    logExcerpt,
    files,
    drivers,
    diff,
    patch,
    waveform,
    manifest,
    redactions: { count: redCount, kinds: [...redKinds] },
    fileLineCounts,
    index,
  };
}
