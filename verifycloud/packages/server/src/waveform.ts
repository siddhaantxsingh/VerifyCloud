// Waveform queries served from the worker-produced index (see shared/vcd.ts).
// Indexes are cached in memory (bounded LRU by approximate size).
import { gunzipSync } from "node:zlib";

import { changesInRange, formatValue, valueAt, type WaveIndex } from "@verifycloud/shared";

import type { Ctx } from "./app.js";

const cache = new Map<string, { idx: WaveIndex; size: number }>();
let cacheBytes = 0;
const CACHE_LIMIT = 256 * 1024 * 1024;

export async function loadWaveIndex(ctx: Ctx, artifactId: string, storageKey: string): Promise<WaveIndex> {
  const hit = cache.get(artifactId);
  if (hit) {
    cache.delete(artifactId);
    cache.set(artifactId, hit);
    return hit.idx;
  }
  const raw = gunzipSync(await ctx.store.getBuffer(storageKey, 128 * 1024 * 1024), { maxOutputLength: 1024 * 1024 * 1024 });
  const idx = JSON.parse(raw.toString("utf8")) as WaveIndex;
  cache.set(artifactId, { idx, size: raw.length });
  cacheBytes += raw.length;
  for (const [k, v] of cache) {
    if (cacheBytes <= CACHE_LIMIT) break;
    cache.delete(k);
    cacheBytes -= v.size;
  }
  return idx;
}

export function searchSignals(w: WaveIndex, q: string, limit = 200) {
  const needle = q.toLowerCase();
  return w.signals.filter((s) => !needle || s.name.toLowerCase().includes(needle)).slice(0, limit);
}

export function signalValues(w: WaveIndex, ids: number[], from: number, to: number, maxPoints: number) {
  return ids
    .filter((id) => w.signals[id])
    .map((id) => {
      const s = w.signals[id]!;
      return { id, name: s.name, width: s.width, changes: changesInRange(w.changes[id], from, to, maxPoints).map(([t, v]) => [t, v === "*" ? "*" : formatValue(v, s.width)]) };
    });
}

/** A text table of the given (short-named) signals around a time window, for AI context. */
export function valuesInWindow(w: WaveIndex, names: string[], from: bigint, to: bigint): { signals: string[]; table: string } {
  const f = Number(from);
  const t = Number(to);
  const chosen = new Map<string, number>();
  for (const n of names) {
    // prefer the DUT-side instance of a signal: shortest hierarchical name ending in .n
    const cands = w.signals.filter((s) => s.name === n || s.name.endsWith("." + n)).sort((a, b) => a.name.length - b.name.length);
    if (cands[0]) chosen.set(cands[0].name, cands[0].id);
  }
  if (chosen.size === 0) return { signals: [], table: "" };
  const times = new Set<number>([f]);
  for (const id of chosen.values()) for (const [tm] of changesInRange(w.changes[id], f, t, 10_000)) times.add(tm);
  const sorted = [...times].filter((x) => x >= f && x <= t).sort((a, b) => a - b).slice(0, 60);
  const cols = [...chosen.keys()];
  const header = `time(${w.timescale}) | ${cols.map((c) => c.split(".").slice(-2).join(".")).join(" | ")}`;
  const rows = sorted.map((tm) => `${tm} | ${cols.map((c) => formatValue(valueAt(w.changes[chosen.get(c)!], tm), w.signals[chosen.get(c)!]!.width)).join(" | ")}`);
  return { signals: cols, table: [header, ...rows].join("\n") };
}
