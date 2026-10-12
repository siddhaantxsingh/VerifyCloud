// VCD (IEEE 1364 value change dump) parsing into a compact, queryable index.
//
// The worker parses the VCD a simulation produced and uploads, next to the
// compressed VCD itself, an index: the scope/signal hierarchy and, per
// signal, its value changes. The server answers waveform queries (signal
// search, values in a time window, downsampled for display) from the index,
// so the browser never downloads the whole waveform. Limits bound memory:
// beyond maxChanges value changes the index is marked truncated (the full
// VCD remains downloadable).

export interface WaveSignal {
  id: number;
  name: string; // full hierarchical name, e.g. tb_top.dut.rdata
  width: number;
  kind: string; // wire, reg, logic, ...
}

export interface WaveIndex {
  version: 1;
  timescale: string; // e.g. "1ps"
  endTime: number;
  clockPeriod: number | null; // estimated from the most frequently toggling 1-bit signal
  truncated: boolean;
  signals: WaveSignal[];
  // per signal id: [time, value, time, value, ...] (values as binary strings, "x"/"z" allowed)
  changes: Record<number, (number | string)[]>;
}

export interface VcdLimits {
  maxSignals: number;
  maxChanges: number;
}

/** Parse VCD text into a WaveIndex. Streaming-friendly: processes the text line by line. */
export function parseVcd(text: string, limits: VcdLimits = { maxSignals: 20_000, maxChanges: 5_000_000 }): WaveIndex {
  const idx: WaveIndex = { version: 1, timescale: "1s", endTime: 0, clockPeriod: null, truncated: false, signals: [], changes: {} };
  const scopes: string[] = [];
  const codeToIds = new Map<string, number[]>();
  let time = 0;
  let nChanges = 0;
  let inHeader = true;
  let pos = 0;
  const len = text.length;
  const record = (code: string, value: string) => {
    const ids = codeToIds.get(code);
    if (!ids) return;
    if (nChanges >= limits.maxChanges) {
      idx.truncated = true;
      return;
    }
    for (const id of ids) {
      const arr = (idx.changes[id] ??= []);
      // collapse duplicate consecutive values and multiple changes at one time
      if (arr.length >= 2 && arr[arr.length - 2] === time) arr[arr.length - 1] = value;
      else if (arr.length >= 2 && arr[arr.length - 1] === value) continue;
      else {
        arr.push(time, value);
        nChanges++;
      }
    }
  };
  while (pos < len) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = len;
    const line = text.slice(pos, end).trim();
    pos = end + 1;
    if (!line) continue;
    if (inHeader) {
      if (line.startsWith("$timescale")) {
        let ts = line.replace("$timescale", "").replace("$end", "").trim();
        while (!ts && pos < len) {
          let e2 = text.indexOf("\n", pos);
          if (e2 < 0) e2 = len;
          ts = text.slice(pos, e2).replace("$end", "").trim();
          pos = e2 + 1;
        }
        idx.timescale = ts.replace(/\s+/g, "");
      } else if (line.startsWith("$scope")) {
        const parts = line.split(/\s+/);
        scopes.push(parts[2] ?? "?");
      } else if (line.startsWith("$upscope")) {
        scopes.pop();
      } else if (line.startsWith("$var")) {
        // $var <type> <width> <code> <name> [<range>] $end
        const parts = line.split(/\s+/);
        const kind = parts[1] ?? "wire";
        const width = Number(parts[2] ?? 1);
        const code = parts[3] ?? "";
        const name = [...scopes, parts[4] ?? "?"].join(".");
        if (idx.signals.length < limits.maxSignals) {
          const id = idx.signals.length;
          idx.signals.push({ id, name, width, kind });
          const list = codeToIds.get(code) ?? [];
          list.push(id);
          codeToIds.set(code, list);
        } else idx.truncated = true;
      } else if (line.startsWith("$enddefinitions")) {
        inHeader = false;
      }
      continue;
    }
    const c = line[0]!;
    if (c === "#") {
      time = Number(line.slice(1));
      if (time > idx.endTime) idx.endTime = time;
    } else if (c === "b" || c === "B" || c === "r" || c === "R") {
      const sp = line.indexOf(" ");
      if (sp > 0) record(line.slice(sp + 1).trim(), line.slice(1, sp).toLowerCase());
    } else if (c === "0" || c === "1" || c === "x" || c === "X" || c === "z" || c === "Z") {
      record(line.slice(1).trim(), c.toLowerCase());
    } else if (c === "$") {
      // $dumpvars / $end / $dumpall etc.: values inside are handled by the branches above
    }
  }
  idx.clockPeriod = estimateClock(idx);
  return idx;
}

function estimateClock(idx: WaveIndex): number | null {
  let best: { n: number; period: number } | null = null;
  for (const s of idx.signals) {
    if (s.width !== 1) continue;
    const ch = idx.changes[s.id];
    if (!ch || ch.length < 8) continue;
    const rises: number[] = [];
    for (let i = 0; i < ch.length; i += 2) if (ch[i + 1] === "1") rises.push(ch[i] as number);
    if (rises.length < 4) continue;
    const d = rises[2]! - rises[1]!;
    const regular = rises.slice(1, 20).every((t, i, a) => i === 0 || t - a[i - 1]! === d);
    if (regular && d > 0 && (!best || rises.length > best.n)) best = { n: rises.length, period: d };
  }
  return best?.period ?? null;
}

/** Value of a signal at time t (last change at or before t). */
export function valueAt(ch: (number | string)[] | undefined, t: number): string | null {
  if (!ch || ch.length === 0) return null;
  let lo = 0;
  let hi = ch.length / 2 - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((ch[mid * 2] as number) <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans < 0 ? null : (ch[ans * 2 + 1] as string);
}

/** Changes of a signal within [from, to], downsampled to at most maxPoints (keeps the first change per bucket). */
export function changesInRange(ch: (number | string)[] | undefined, from: number, to: number, maxPoints = 2000): [number, string][] {
  const out: [number, string][] = [];
  if (!ch) return out;
  const start = valueAt(ch, from);
  if (start !== null) out.push([from, start]);
  const bucket = Math.max(1, (to - from) / maxPoints);
  let lastBucket = -1;
  for (let i = 0; i < ch.length; i += 2) {
    const t = ch[i] as number;
    if (t <= from) continue;
    if (t > to) break;
    const b = Math.floor((t - from) / bucket);
    if (b === lastBucket && out.length > 1) {
      out[out.length - 1] = [out[out.length - 1]![0], "*"]; // several changes collapsed into one display bucket
      continue;
    }
    lastBucket = b;
    out.push([t, ch[i + 1] as string]);
  }
  return out;
}

/** Binary value string to hex for display (keeps x/z). */
export function formatValue(v: string | null, width: number): string {
  if (v === null) return "?";
  if (width === 1 || /[xz]/.test(v)) return v;
  const padded = v.padStart(Math.ceil(v.length / 4) * 4, "0");
  let hex = "";
  for (let i = 0; i < padded.length; i += 4) hex += parseInt(padded.slice(i, i + 4), 2).toString(16);
  return "0x" + hex.replace(/^0+(?=.)/, "");
}
