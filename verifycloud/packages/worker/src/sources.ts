// Source acquisition for a job: snapshot extraction or git fetch, patch
// application, and resolution of the configured source globs.
//
// Archives and repositories are untrusted: extraction writes regular files
// only (no symlinks, hard links or devices), rejects absolute and ".." paths,
// and enforces file-count and byte limits. git runs with hooks disabled, no
// credential prompts, local-file transport disabled, and the access token
// passed in an HTTP header (never in the URL or remote configuration).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, lstatSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { applyFilePatch, globMatch, parseUnifiedDiff, redact, safeRelativePattern, tarFiles, type ProjectConfig } from "@verifycloud/shared";
import picomatch from "picomatch";
import { Parser, type ReadEntry } from "tar";

import type { ResolvedSources } from "./adapters/types.js";

export class SourceError extends Error {}

const LIMITS = { maxFiles: 20_000 };

export async function extractSnapshot(gz: Buffer, dest: string, maxBytes: number): Promise<number> {
  mkdirSync(dest, { recursive: true });
  const root = resolve(dest);
  const tar = gunzipSync(gz, { maxOutputLength: maxBytes + 1024 * 1024 });
  let files = 0;
  let bytes = 0;
  let error: Error | null = null;
  await new Promise<void>((done, fail) => {
    const p = new Parser({ strict: true });
    p.on("entry", (e: ReadEntry) => {
      const path = e.path.replace(/^\.\//, "");
      if (error) return e.resume();
      if (e.type === "Directory") return e.resume();
      if (e.type !== "File" && e.type !== "OldFile" && e.type !== "ContiguousFile") {
        error = new SourceError(`archive entry ${path.slice(0, 80)} is a ${e.type}; only regular files are allowed`);
        return e.resume();
      }
      const target = resolve(root, path);
      if (!safeRelativePattern(path) || !target.startsWith(root + sep)) {
        error = new SourceError(`unsafe path in archive: ${path.slice(0, 80)}`);
        return e.resume();
      }
      files++;
      bytes += e.size ?? 0;
      if (files > LIMITS.maxFiles || bytes > maxBytes) {
        error = new SourceError("archive exceeds the file count or size limit");
        return e.resume();
      }
      mkdirSync(dirname(target), { recursive: true });
      const chunks: Buffer[] = [];
      e.on("data", (c: Buffer) => chunks.push(c));
      e.on("end", () => writeFileSync(target, Buffer.concat(chunks), { mode: 0o644 }));
    });
    p.on("error", (e: Error) => fail(new SourceError(`invalid archive: ${e.message}`)));
    p.on("end", () => done());
    p.end(tar);
  });
  if (error) throw error;
  return files;
}

/** Fetch exactly one commit of a repository. Returns nothing; the tree is in dest. */
export function gitFetch(dest: string, creds: { cloneUrl: string; sha: string; username: string; token: string }, timeoutMs: number) {
  mkdirSync(dest, { recursive: true });
  const header = `Authorization: Basic ${Buffer.from(`${creds.username}:${creds.token}`).toString("base64")}`;
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dest, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_ASKPASS: "/bin/false" };
  const base = ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", "-c", "core.symlinks=false", "-c", "advice.detachedHead=false"];
  const run = (args: string[], secretHeader = false) => {
    // the credential goes through the environment (GIT_CONFIG_*), never argv:
    // command lines are visible to every process on the host via /proc
    const e = secretHeader ? { ...env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: header } : env;
    const r = spawnSync("git", [...base, ...args], { cwd: dest, env: e, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) throw new SourceError(`git ${args[0]} failed: ${redact(`${r.stderr ?? ""}${r.error?.message ?? ""}`, [creds.token, header]).text.slice(0, 500)}`);
  };
  run(["init", "-q"]);
  if (!/^[0-9a-f]{40}$/.test(creds.sha)) throw new SourceError("invalid commit sha");
  if (!/^https:\/\//.test(creds.cloneUrl)) throw new SourceError("clone URL must be https");
  run(["fetch", "-q", "--depth", "1", "--no-tags", "--", creds.cloneUrl, creds.sha], true);
  run(["checkout", "-q", "--detach", "FETCH_HEAD"]);
  rmSync(join(dest, ".git"), { recursive: true, force: true });
}

/** All regular files under dir (relative paths, "/" separators), refusing symlinks. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) throw new SourceError(`symbolic links are not allowed in sources: ${relative(dir, p)}`);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

export function snapshotTree(dir: string, maxBytes: number): Buffer {
  let total = 0;
  const files = listFiles(dir).map((p) => {
    const content = readFileSync(join(dir, p));
    total += content.length;
    if (total > maxBytes) throw new SourceError("repository exceeds the size limit");
    return { path: p, content };
  });
  return gzipSync(tarFiles(files), { level: 6 });
}

export function applyPatch(dir: string, diff: string) {
  const root = resolve(dir);
  for (const fp of parseUnifiedDiff(diff)) {
    const read = (p: string | null) => {
      if (p === null) return null;
      const f = resolve(root, p);
      if (!f.startsWith(root + sep)) throw new SourceError(`patch path escapes the workspace: ${p}`);
      try {
        if (lstatSync(f).isSymbolicLink()) throw new SourceError(`patch targets a symbolic link: ${p}`);
        return readFileSync(f, "utf8");
      } catch (e) {
        if (e instanceof SourceError) throw e;
        return null;
      }
    };
    const next = applyFilePatch(read(fp.oldPath), fp);
    const target = fp.newPath ?? fp.oldPath!;
    const abs = resolve(root, target);
    if (!abs.startsWith(root + sep)) throw new SourceError(`patch path escapes the workspace: ${target}`);
    if (next === null) rmSync(abs, { force: true });
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, next);
    }
  }
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * Resolve the configured globs against the source tree, in configuration
 * order (RTL patterns, then testbench patterns; within a pattern, sorted).
 * Order matters for SystemVerilog packages, so it is explicit and stable.
 */
export function resolveSources(dir: string, cfg: ProjectConfig): ResolvedSources {
  const all = listFiles(dir);
  const files: string[] = [];
  const missing: string[] = [];
  for (const pattern of [...cfg.rtl.sources, ...cfg.testbench.sources]) {
    const m = all.filter((f) => picomatch.isMatch(f, pattern, { dot: false }));
    if (m.length === 0) missing.push(pattern);
    for (const f of m) if (!files.includes(f)) files.push(f);
  }
  if (missing.length) throw new SourceError(`source pattern(s) matched no files: ${missing.join(", ")}`);
  const includeDirs = cfg.rtl.includeDirs;
  for (const d of includeDirs) {
    try {
      if (!statSync(join(dir, d)).isDirectory()) throw new Error();
    } catch {
      throw new SourceError(`include directory not found: ${d}`);
    }
  }
  const hashes: Record<string, string> = {};
  // The cache key covers EVERY file in the tree, not only the matched sources:
  // `include files, $readmem data and files pulled in by flags also end up in
  // the compiled model (audit 2026-10-08: a changed header outside the globs
  // used to reuse a stale or foreign model).
  for (const f of all) hashes[f] = sha256(readFileSync(join(dir, f)));
  return { files, includeDirs, hashes };
}

export function cacheKey(material: Record<string, unknown>, src: ResolvedSources): string {
  const h = createHash("sha256");
  h.update(JSON.stringify(material));
  h.update(JSON.stringify(src.files));
  for (const k of Object.keys(src.hashes).sort()) h.update(`${k}\0${src.hashes[k]}\n`);
  return h.digest("hex");
}

export { globMatch };
