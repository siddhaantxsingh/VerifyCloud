// Browser-side snapshot: deterministic ustar archive of selected files,
// gzip-compressed with CompressionStream. Mirrors packages/shared/src/tarball.ts.
const enc = new TextEncoder();
const SKIP_DIR = /(^|\/)(\.[^/]*|node_modules|obj_dir|dist|build)(\/|$)/;
const SKIP_EXT = /\.(vcd|fst|fsdb|wlf|vpd|o|a|so|dylib|exe|dll)$/i;

export interface PickedFile {
  path: string;
  file: File;
}

/** Files from an <input webkitdirectory> selection, with the top folder name stripped. */
export function fromDirectoryInput(list: FileList): { files: PickedFile[]; skipped: number } {
  const files: PickedFile[] = [];
  let skipped = 0;
  for (const f of Array.from(list)) {
    const rel = (f as File & { webkitRelativePath: string }).webkitRelativePath || f.name;
    const path = rel.includes("/") ? rel.slice(rel.indexOf("/") + 1) : rel;
    if (!path || SKIP_DIR.test(path) || SKIP_EXT.test(path)) {
      skipped++;
      continue;
    }
    files.push({ path, file: f });
  }
  return { files, skipped };
}

function header(path: string, size: number): Uint8Array<ArrayBuffer> {
  const h = new Uint8Array(new ArrayBuffer(512));
  let name = path;
  let prefix = "";
  if (enc.encode(name).length > 100) {
    let split = -1;
    for (let i = name.indexOf("/"); i >= 0; i = name.indexOf("/", i + 1)) {
      if (enc.encode(name.slice(0, i)).length <= 155 && enc.encode(name.slice(i + 1)).length <= 100) {
        split = i;
        break;
      }
    }
    if (split < 0) throw new Error(`path too long: ${path.slice(0, 80)}…`);
    prefix = name.slice(0, split);
    name = name.slice(split + 1);
  }
  const put = (s: string, off: number) => h.set(enc.encode(s), off);
  put(name, 0);
  put("0000644\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(size.toString(8).padStart(11, "0") + "\0", 124);
  put("00000000000\0", 136);
  put("        ", 148);
  put("0", 156);
  put("ustar\0", 257);
  put("00", 263);
  put(prefix, 345);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

export async function tarGz(files: PickedFile[]): Promise<Blob> {
  const parts: BlobPart[] = [];
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const data = new Uint8Array(await f.file.arrayBuffer());
    parts.push(header(f.path, data.length), data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  const stream = new Blob(parts).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

/** The first 64 KiB of HDL/config files, for server-side project detection. */
export async function detectionInput(files: PickedFile[]) {
  const out: { path: string; content?: string }[] = [];
  for (const f of files.slice(0, 5000)) {
    const hdl = /\.(sv|svh|v|vh|yaml|yml|f|tcl|py|mk)$|Makefile$/i.test(f.path);
    out.push({ path: f.path, content: hdl ? (await f.file.slice(0, 65536).text()) : undefined });
  }
  return out;
}
