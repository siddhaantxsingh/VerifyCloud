// Deterministic tar (ustar) writer for source snapshots: regular files only,
// sorted paths, fixed metadata, so identical trees give identical archives.
export function tarFiles(files: { path: string; content: Buffer }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
    const h = Buffer.alloc(512);
    // ustar: name (100 bytes) + prefix (155 bytes), split at a "/"
    let name = f.path;
    let prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const cut = name.lastIndexOf("/", name.length - 1 - 0);
      let i = name.indexOf("/");
      let split = -1;
      while (i >= 0 && i <= cut) {
        if (Buffer.byteLength(name.slice(0, i)) <= 155 && Buffer.byteLength(name.slice(i + 1)) <= 100) {
          split = i;
          break;
        }
        i = name.indexOf("/", i + 1);
      }
      if (split < 0) throw new Error(`path too long for a ustar archive: ${f.path.slice(0, 80)}…`);
      prefix = name.slice(0, split);
      name = name.slice(split + 1);
    }
    Buffer.from(name).copy(h, 0);
    Buffer.from(prefix).copy(h, 345);
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(f.content.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, f.content, Buffer.alloc((512 - (f.content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

