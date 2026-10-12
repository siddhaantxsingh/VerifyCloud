// Waveform viewer for VCD artifacts. The server indexes the VCD once and
// returns value changes for the selected signals in a time window
// (downsampled), so large dumps are never shipped to the browser whole.
import { useEffect, useMemo, useRef, useState } from "react";

import { get } from "../api";
import { ErrorBox, Loading } from "./ui";

interface Sig { id: number; name: string; width: number; kind: string }
interface Meta { timescale: string; endTime: number; clockPeriod: number | null; truncated: boolean; signalCount: number; signals: Sig[] }
interface Trace { id: number; name: string; width: number; changes: [number, string][] }

const DEFAULT_RE = /(clk|clock|rst|reset|valid|ready|addr|data|resp|strb)$/i;
const ROW = 26;
const LABEL_W = 230;

export function Waveform({ artifactId, focusTime, highlight = [] }: { artifactId: string; focusTime?: number | null; highlight?: string[] }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Sig[]>([]);
  const [selected, setSelected] = useState<Sig[]>([]);
  const [win, setWin] = useState<[number, number] | null>(null);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [cursor, setCursor] = useState<number | null>(focusTime ?? null);
  const [err, setErr] = useState<unknown>(null);
  const [width, setWidth] = useState(800);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(320, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // metadata + a sensible default selection (top-level testbench handshake signals)
  useEffect(() => {
    (async () => {
      try {
        const m = await get<Meta>(`/artifacts/${artifactId}/waveform/signals?limit=500`);
        setMeta(m);
        const depth = (n: string) => n.split(".").length;
        const minDepth = Math.min(...m.signals.map((s) => depth(s.name)));
        // signals named by the failure analysis first, then top-level handshake signals
        const hl = m.signals.filter((s) => highlight.some((h) => s.name.endsWith(`.${h}`) || s.name.endsWith(h)) && depth(s.name) <= minDepth + 1);
        const top = m.signals.filter((s) => depth(s.name) === minDepth && DEFAULT_RE.test(s.name));
        const clk = top.filter((s) => /(clk|clock)$/i.test(s.name));
        const pick = [...new Map([...clk, ...hl, ...top].map((s) => [s.id, s])).values()].slice(0, 16);
        setSelected(pick.length ? pick : m.signals.slice(0, 8));
        const per = m.clockPeriod ?? Math.max(1, Math.round(m.endTime / 50));
        const f = focusTime ?? m.endTime;
        setWin([Math.max(0, f - 16 * per), Math.min(m.endTime, f + 4 * per) || m.endTime]);
      } catch (e) {
        setErr(e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactId]);

  useEffect(() => {
    if (!win || !selected.length) return;
    const t = setTimeout(async () => {
      try {
        const r = await get<{ signals: Trace[] }>(`/artifacts/${artifactId}/waveform/values?ids=${selected.map((s) => s.id).join(",")}&from=${Math.floor(win[0])}&to=${Math.ceil(win[1])}&maxPoints=${Math.min(5000, Math.round(width * 2))}`);
        setTraces(r.signals);
      } catch (e) {
        setErr(e);
      }
    }, 120);
    return () => clearTimeout(t);
  }, [artifactId, win, selected, width]);

  useEffect(() => {
    if (!search) return setResults([]);
    const t = setTimeout(async () => {
      try {
        setResults((await get<Meta>(`/artifacts/${artifactId}/waveform/signals?q=${encodeURIComponent(search)}&limit=50`)).signals);
      } catch (e) {
        setErr(e);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [search, artifactId]);

  const plotW = width - LABEL_W;
  const x = (t: number) => (win ? ((t - win[0]) / Math.max(1, win[1] - win[0])) * plotW : 0);
  const tAt = (px: number) => (win ? win[0] + (px / plotW) * (win[1] - win[0]) : 0);
  const zoom = (f: number, center?: number) => {
    if (!win || !meta) return;
    const c = center ?? (cursor !== null && cursor >= win[0] && cursor <= win[1] ? cursor : (win[0] + win[1]) / 2);
    const half = Math.max(2, ((win[1] - win[0]) * f) / 2);
    setWin([Math.max(0, c - half), Math.min(meta.endTime, c + half)]);
  };
  const pan = (f: number) => {
    if (!win || !meta) return;
    const d = (win[1] - win[0]) * f;
    const a = Math.min(Math.max(0, win[0] + d), Math.max(0, meta.endTime - (win[1] - win[0])));
    setWin([a, a + (win[1] - win[0])]);
  };
  const valueAt = (tr: Trace, t: number) => {
    let v = "x";
    for (const [ct, cv] of tr.changes) {
      if (ct > t) break;
      v = cv;
    }
    return v;
  };
  const ticks = useMemo(() => {
    if (!win) return [];
    const span = win[1] - win[0];
    const raw = span / 8;
    const p = 10 ** Math.floor(Math.log10(Math.max(1, raw)));
    const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
    const out: number[] = [];
    for (let t = Math.ceil(win[0] / step) * step; t <= win[1]; t += step) out.push(t);
    return out;
  }, [win]);

  if (err) return <ErrorBox error={err} />;
  if (!meta || !win) return <Loading what="Loading waveform" />;
  const H = 22 + traces.length * ROW;
  return (
    <div className="wave">
      <div className="wavebar">
        <button className="btn tiny" onClick={() => zoom(0.5)} aria-label="Zoom in">+</button>
        <button className="btn tiny" onClick={() => zoom(2)} aria-label="Zoom out">−</button>
        <button className="btn tiny" onClick={() => pan(-0.5)} aria-label="Pan left">◀</button>
        <button className="btn tiny" onClick={() => pan(0.5)} aria-label="Pan right">▶</button>
        <button className="btn tiny" onClick={() => setWin([0, meta.endTime])}>Fit</button>
        {focusTime != null && <button className="btn tiny" onClick={() => { setCursor(focusTime); zoom(1, focusTime); }}>Go to failure ({focusTime})</button>}
        <span className="small muted">window {Math.round(win[0])}–{Math.round(win[1])} {meta.timescale} · cursor {cursor ?? "—"} · {meta.signalCount} signals{meta.truncated ? " · dump truncated at the size limit" : ""}</span>
      </div>
      <div className="wavesearch">
        <input placeholder="Add signal: search by name" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search signals" />
        {results.length > 0 && (
          <ul className="wavesuggest" role="listbox">
            {results.map((s) => (
              <li key={s.id}><button className="link" onClick={() => { if (!selected.some((x) => x.id === s.id) && selected.length < 64) setSelected([...selected, s]); setSearch(""); }}>{s.name} <span className="muted">[{s.width}]</span></button></li>
            ))}
          </ul>
        )}
      </div>
      <div ref={box} className="wavebox">
        <svg width={width} height={H} role="img" aria-label="Waveform" onClick={(e) => { const r = (e.currentTarget as SVGElement).getBoundingClientRect(); const px = e.clientX - r.left - LABEL_W; if (px >= 0) setCursor(Math.round(tAt(px))); }}>
          <g transform={`translate(${LABEL_W},0)`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={16} y2={H} className="grid" />
                <text x={x(t)} y={12} textAnchor="middle" className="axis">{t}</text>
              </g>
            ))}
          </g>
          {traces.map((tr, i) => {
            const y0 = 22 + i * ROW;
            const sig = selected.find((s) => s.id === tr.id);
            const changes = tr.changes;
            const segs: [number, number, string][] = changes.map(([t, v], k) => [Math.max(t, win[0]), k + 1 < changes.length ? changes[k + 1]![0] : win[1], v]);
            const hl = highlight.some((h) => tr.name.endsWith(`.${h}`));
            return (
              <g key={tr.id}>
                <text x={4} y={y0 + 16} className={`siglabel ${hl ? "hl" : ""}`}>
                  <title>{tr.name}</title>
                  {tr.name.split(".").slice(-2).join(".")}{tr.width > 1 ? `[${tr.width - 1}:0]` : ""}
                </text>
                <text x={LABEL_W - 6} y={y0 + 16} textAnchor="end" className="sigval">{cursor !== null ? valueAt(tr, cursor) : ""}</text>
                <g transform={`translate(${LABEL_W},${y0})`}>
                  {segs.map(([a, b, v], k) => {
                    const xa = x(a);
                    const xb = x(Math.min(b, win[1]));
                    if (xb < 0 || xa > plotW) return null;
                    const unknown = /[xz]/i.test(v.replace(/^0x/i, ""));
                    if (tr.width === 1) {
                      const yv = v === "1" ? 4 : 20;
                      const prev = k > 0 ? segs[k - 1]![2] : null;
                      return (
                        <g key={k} className={unknown ? "xz" : "bit"}>
                          {prev !== null && prev !== v && <line x1={xa} x2={xa} y1={4} y2={20} />}
                          {unknown ? <rect x={xa} y={4} width={Math.max(0, xb - xa)} height={16} /> : <line x1={xa} x2={xb} y1={yv} y2={yv} />}
                        </g>
                      );
                    }
                    const w = Math.max(0, xb - xa);
                    return (
                      <g key={k} className={unknown ? "xz bus" : "bus"}>
                        <polygon points={`${xa},12 ${xa + Math.min(3, w / 2)},4 ${xb - Math.min(3, w / 2)},4 ${xb},12 ${xb - Math.min(3, w / 2)},20 ${xa + Math.min(3, w / 2)},20`} />
                        {w > 34 && <text x={xa + w / 2} y={16} textAnchor="middle">{v}</text>}
                      </g>
                    );
                  })}
                </g>
                <line x1={0} x2={width} y1={y0 + ROW - 1} y2={y0 + ROW - 1} className="rowline" />
              </g>
            );
          })}
          {cursor !== null && cursor >= win[0] && cursor <= win[1] && <line x1={LABEL_W + x(cursor)} x2={LABEL_W + x(cursor)} y1={16} y2={H} className="cursor" />}
          {focusTime != null && focusTime >= win[0] && focusTime <= win[1] && <line x1={LABEL_W + x(focusTime)} x2={LABEL_W + x(focusTime)} y1={16} y2={H} className="failmark"><title>assertion failure</title></line>}
        </svg>
      </div>
      <div className="small">
        Signals:{" "}
        {selected.map((s) => (
          <span key={s.id} className="chip">{s.name.split(".").slice(-2).join(".")} <button className="link" aria-label={`Remove ${s.name}`} onClick={() => setSelected(selected.filter((x) => x.id !== s.id))}>×</button></span>
        ))}
      </div>
    </div>
  );
}
