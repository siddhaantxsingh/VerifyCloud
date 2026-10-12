// Unified-diff parsing and strict application (exact context match, no fuzz).
// Used by the server to validate that a patch applies to a job's sources
// before creating a verification job, and by the worker to apply it.
import { safeRelativePattern } from "./config.js";

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[]; // each starts with ' ', '-', '+'
}

export interface FilePatch {
  oldPath: string | null; // null = new file
  newPath: string | null; // null = deleted file
  hunks: Hunk[];
}

export class PatchError extends Error {}

const stripPrefix = (p: string) => {
  const s = p.split("\t")[0]!.trim();
  if (s === "/dev/null") return null;
  return s.replace(/^[ab]\//, "");
};

export function parseUnifiedDiff(diff: string, maxBytes = 1_000_000): FilePatch[] {
  if (diff.length > maxBytes) throw new PatchError(`patch larger than ${maxBytes} bytes`);
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const files: FilePatch[] = [];
  let cur: FilePatch | null = null;
  let hunk: Hunk | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      cur = { oldPath: stripPrefix(l.slice(4)), newPath: stripPrefix(lines[i + 1]!.slice(4)), hunks: [] };
      for (const p of [cur.oldPath, cur.newPath]) if (p !== null && !safeRelativePattern(p)) throw new PatchError(`unsafe path in patch: ${p}`);
      if (cur.oldPath === null && cur.newPath === null) throw new PatchError("patch entry without a file");
      files.push(cur);
      hunk = null;
      i++;
      continue;
    }
    const m = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      if (!cur) throw new PatchError("hunk before file header");
      hunk = { oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]), lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (hunk && (l.startsWith(" ") || l.startsWith("-") || l.startsWith("+"))) hunk.lines.push(l);
    else if (hunk && l === "" && i < lines.length - 1) hunk.lines.push(" "); // tools sometimes strip the space of empty context lines
    else if (l.startsWith("\\ No newline")) continue;
  }
  if (files.length === 0) throw new PatchError("no file changes found in patch");
  for (const f of files)
    for (const h of f.hunks) {
      const o = h.lines.filter((x) => x[0] !== "+").length;
      const n = h.lines.filter((x) => x[0] !== "-").length;
      if (o !== h.oldLines || n !== h.newLines) throw new PatchError(`hunk @@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ in ${f.newPath ?? f.oldPath} has inconsistent line counts`);
    }
  return files;
}

/** Apply one file patch to its content (null = file absent). Returns the new content (null = deleted). */
export function applyFilePatch(content: string | null, fp: FilePatch): string | null {
  if (fp.newPath === null) return null;
  const src = content === null ? [] : content.split("\n");
  const out: string[] = [];
  let pos = 0; // index into src
  for (const h of fp.hunks) {
    const start = Math.max(0, h.oldStart - 1);
    if (start < pos) throw new PatchError(`overlapping hunks in ${fp.newPath}`);
    out.push(...src.slice(pos, start));
    let k = start;
    for (const l of h.lines) {
      const body = l.slice(1);
      if (l[0] === "+") out.push(body);
      else {
        if (src[k] !== body) throw new PatchError(`patch does not apply to ${fp.newPath} at line ${k + 1}: expected "${body.slice(0, 80)}"`);
        if (l[0] === " ") out.push(body);
        k++;
      }
    }
    pos = k;
  }
  out.push(...src.slice(pos));
  return out.join("\n");
}

export function patchedFiles(fps: FilePatch[]): string[] {
  return [...new Set(fps.flatMap((f) => [f.oldPath, f.newPath].filter((x): x is string => x !== null)))];
}
