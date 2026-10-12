// Source snapshot: a deterministic, gzip-compressed tar of the working tree
// (no VCS metadata, build outputs or ignored files). Symlinks are skipped:
// the server refuses links, and following them could leak files from outside
// the project.
import { lstatSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

import { globMatch, tarFiles } from "@verifycloud/shared";

export const SNAPSHOT_MAX_FILES = 20_000;
export const SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
const ALWAYS_SKIP = new Set([".git", ".hg", ".svn", "node_modules", "obj_dir", "dist", "build", ".verifycloud"]);
const SKIP_EXT = /\.(vcd|fst|fsdb|wlf|vpd|o|a|so|dylib|exe|dll)$/i;

export interface SnapshotResult {
  gz: Buffer;
  files: string[];
  skipped: { path: string; reason: string }[];
  bytes: number;
}

export function readIgnore(dir: string): string[] {
  const p = join(dir, ".verifycloudignore");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => (l.endsWith("/") ? `${l}**` : l));
}

export function snapshotDir(dir: string): SnapshotResult {
  const ignore = readIgnore(dir);
  const files: { path: string; content: Buffer }[] = [];
  const skipped: SnapshotResult["skipped"] = [];
  let bytes = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name);
      const rel = relative(dir, abs).split("\\").join("/");
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        skipped.push({ path: rel, reason: "symlink" });
        continue;
      }
      if (st.isDirectory()) {
        if (ALWAYS_SKIP.has(name) || name.startsWith(".")) continue;
        if (ignore.length && (globMatch(ignore, rel) || globMatch(ignore, rel + "/"))) continue;
        walk(abs);
        continue;
      }
      if (!st.isFile()) continue;
      if (name.startsWith(".") && name !== ".verifycloudignore") continue;
      if (ignore.length && globMatch(ignore, rel)) continue;
      if (SKIP_EXT.test(name)) {
        skipped.push({ path: rel, reason: "build output or waveform" });
        continue;
      }
      bytes += st.size;
      if (files.length >= SNAPSHOT_MAX_FILES) throw new Error(`more than ${SNAPSHOT_MAX_FILES} files; add a .verifycloudignore`);
      if (bytes > SNAPSHOT_MAX_BYTES) throw new Error(`sources exceed ${SNAPSHOT_MAX_BYTES / 1024 / 1024} MiB; add a .verifycloudignore`);
      files.push({ path: rel, content: readFileSync(abs) });
    }
  };
  walk(dir);
  if (!files.some((f) => f.path === "verifycloud.yaml")) throw new Error(`no verifycloud.yaml in ${dir}`);
  return { gz: gzipSync(tarFiles(files), { level: 9 }), files: files.map((f) => f.path), skipped, bytes };
}
