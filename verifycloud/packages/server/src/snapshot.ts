// Source snapshots (tar.gz of a repository tree). Uploaded archives are
// untrusted: they are inspected entry by entry without being written to disk,
// and rejected if they contain absolute paths, "..", links, device files,
// too many files or too many bytes.
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";

import { Parser, type ReadEntry } from "tar";

import { E } from "./errors.js";

export const SNAPSHOT_LIMITS = { maxFiles: 20_000, maxUnpackedBytes: 512 * 1024 * 1024, maxPathLength: 400 };

export interface SnapshotInfo {
  fileCount: number;
  unpackedBytes: number;
  configText: string | null;
  paths: string[];
}

function badPath(p: string) {
  return !p || p.length > SNAPSHOT_LIMITS.maxPathLength || p.startsWith("/") || p.split("/").some((s) => s === "..") || /[\0\\]/.test(p);
}
const norm = (p: string) => p.replace(/^\.\//, "");

async function walk(gz: Buffer, onFile: (path: string, entry: ReadEntry) => Promise<void> | void): Promise<{ files: number; bytes: number }> {
  let tarBuf: Buffer;
  try {
    tarBuf = gunzipSync(gz, { maxOutputLength: SNAPSHOT_LIMITS.maxUnpackedBytes + 10 * 1024 * 1024 });
  } catch {
    throw E.validation("snapshot is not a valid gzip archive or unpacks to more than the size limit");
  }
  let files = 0;
  let bytes = 0;
  let failure: Error | null = null;
  const pending: Promise<void>[] = [];
  await new Promise<void>((resolve, reject) => {
    const p = new Parser({ strict: true });
    p.on("entry", (entry: ReadEntry) => {
      const path = norm(entry.path);
      if (failure) return entry.resume();
      if (entry.type === "Directory") return entry.resume();
      if (entry.type !== "File" && entry.type !== "OldFile" && entry.type !== "ContiguousFile") {
        failure = E.validation(`snapshot contains a ${entry.type} entry (${path.slice(0, 100)}); only regular files and directories are allowed`);
        return entry.resume();
      }
      if (badPath(path)) {
        failure = E.validation(`snapshot contains an unsafe path: ${path.slice(0, 100)}`);
        return entry.resume();
      }
      files++;
      bytes += entry.size ?? 0;
      if (files > SNAPSHOT_LIMITS.maxFiles) failure = E.validation(`snapshot has more than ${SNAPSHOT_LIMITS.maxFiles} files`);
      if (bytes > SNAPSHOT_LIMITS.maxUnpackedBytes) failure = E.validation("snapshot unpacks to more than the size limit");
      if (failure) return entry.resume();
      const r = onFile(path, entry);
      if (r) pending.push(r.catch((e) => void (failure = e)));
      else entry.resume();
    });
    p.on("error", (e: Error) => reject(E.validation(`snapshot is not a valid tar archive: ${e.message}`)));
    p.on("end", () => resolve());
    Readable.from([tarBuf]).pipe(p as unknown as NodeJS.WritableStream);
  });
  await Promise.all(pending);
  if (failure) throw failure;
  return { files, bytes };
}

async function entryText(entry: ReadEntry, max: number): Promise<string | null> {
  if ((entry.size ?? 0) > max) {
    entry.resume();
    return null;
  }
  const chunks: Buffer[] = [];
  for await (const c of entry as unknown as AsyncIterable<Buffer>) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

export async function inspectSnapshot(gz: Buffer, configPath = "verifycloud.yaml"): Promise<SnapshotInfo> {
  let configText: string | null = null;
  const paths: string[] = [];
  const r = await walk(gz, async (path, entry) => {
    paths.push(path);
    if (path === configPath) configText = await entryText(entry, 256 * 1024);
    else entry.resume();
  });
  return { fileCount: r.files, unpackedBytes: r.bytes, configText, paths };
}

/** Read selected text files (by predicate) from a snapshot, with a total byte budget. */
export async function readSnapshotFiles(gz: Buffer, want: (path: string) => boolean, maxFileBytes = 1024 * 1024, maxTotal = 16 * 1024 * 1024): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let total = 0;
  await walk(gz, async (path, entry) => {
    if (!want(path) || total + (entry.size ?? 0) > maxTotal) return void entry.resume();
    const t = await entryText(entry, maxFileBytes);
    if (t !== null) {
      out.set(path, t);
      total += t.length;
    }
  });
  return out;
}
