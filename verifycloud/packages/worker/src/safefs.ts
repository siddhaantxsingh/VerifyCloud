// Reading files that an untrusted sandbox could have written.
//
// The run's output directory is a bind mount the sandbox controls. Anything
// in it may be a symlink (to a host file such as /proc/self/environ), a FIFO
// (an open() would block the worker forever), a device node, or huge. The
// worker therefore never uses path-based reads on it: files are opened with
// O_NOFOLLOW | O_NONBLOCK, verified to be regular files on the open
// descriptor (no TOCTOU between check and read), and read up to a size limit.
// (Audit 2026-10-08, findings C1/C2.)
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

export class UnsafeFileError extends Error {}

export type SafeRead = { ok: true; data: Buffer } | { ok: false; reason: string };

/** Read a file from untrusted output. Never follows symlinks, never blocks, never reads more than maxBytes. */
export function readUntrusted(path: string, maxBytes: number): SafeRead {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, reason: "missing" };
    if (code === "ELOOP") return { ok: false, reason: "is a symbolic link (not a regular file); ignored" };
    return { ok: false, reason: `cannot be opened (${code ?? "error"})` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: "is not a regular file; ignored" };
    if (st.size > maxBytes) return { ok: false, reason: `is ${st.size} bytes, over the ${maxBytes}-byte limit` };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return { ok: true, data: off === st.size ? buf : buf.subarray(0, off) };
  } finally {
    closeSync(fd);
  }
}

/** Is there a (non-symlink) entry at path? Does not follow links. */
export function existsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Size of an untrusted directory tree, bounded in work: stops (returns
 * exceeded) after maxEntries entries or maxDepth levels instead of walking an
 * adversarial tree of millions of files. Does not follow symlinks.
 */
export function boundedDirUsage(root: string, limits: { maxEntries: number; maxDepth: number }): { bytes: number; entries: number; exceeded: string | null } {
  let bytes = 0;
  let entries = 0;
  const stack: { p: string; depth: number }[] = [{ p: root, depth: 0 }];
  while (stack.length) {
    const { p, depth } = stack.pop()!;
    if (depth > limits.maxDepth) return { bytes, entries, exceeded: `directory nesting deeper than ${limits.maxDepth}` };
    let list;
    try {
      list = readdirSync(p, { withFileTypes: true });
    } catch {
      continue; // racing with the workload
    }
    for (const e of list) {
      if (++entries > limits.maxEntries) return { bytes, entries, exceeded: `more than ${limits.maxEntries} files` };
      const f = join(p, e.name);
      if (e.isDirectory()) stack.push({ p: f, depth: depth + 1 });
      else if (e.isFile()) {
        try {
          // allocated blocks, not apparent size: sparse files are counted by what they use
          const st = lstatSync(f);
          bytes += Math.max(st.blocks * 512, 0);
        } catch {
          /* racing */
        }
      }
    }
  }
  return { bytes, entries, exceeded: null };
}
