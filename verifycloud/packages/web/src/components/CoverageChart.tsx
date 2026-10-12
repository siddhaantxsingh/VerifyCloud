import { Link } from "react-router-dom";

import { pct } from "../api";

const SERIES = [
  { k: "line", color: "var(--c1)" },
  { k: "branch", color: "var(--c2)" },
  { k: "toggle", color: "var(--c3)" },
  { k: "functional", color: "var(--c4)" },
] as const;

/** Coverage (%) per merged job, oldest → newest. Only measured values are plotted. */
export function CoverageChart({ points }: { points: { jobId: string; number: number; at: string; coverage: Record<string, { covered: number; total: number }> }[] }) {
  const W = 560;
  const H = 180;
  const pad = { l: 36, r: 10, t: 10, b: 24 };
  const n = points.length;
  const x = (i: number) => pad.l + (n <= 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (n - 1));
  const y = (v: number) => pad.t + (1 - v / 100) * (H - pad.t - pad.b);
  const present = SERIES.filter((s) => points.some((p) => p.coverage[s.k]));
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Coverage history chart">
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="grid" />
            <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" className="axis">{v}</text>
          </g>
        ))}
        {present.map((s) => {
          const pts = points.map((p, i) => [i, pct(p.coverage[s.k])] as const).filter(([, v]) => v !== null) as [number, number][];
          return (
            <g key={s.k}>
              <polyline fill="none" stroke={s.color} strokeWidth="2" points={pts.map(([i, v]) => `${x(i)},${y(v)}`).join(" ")} />
              {pts.map(([i, v]) => (
                <circle key={i} cx={x(i)} cy={y(v)} r="3" fill={s.color}>
                  <title>{`#${points[i]!.number} ${s.k}: ${v.toFixed(1)}%`}</title>
                </circle>
              ))}
            </g>
          );
        })}
        {points.map((p, i) => (n <= 12 || i % Math.ceil(n / 12) === 0 ? <text key={p.jobId} x={x(i)} y={H - 6} textAnchor="middle" className="axis">#{p.number}</text> : null))}
      </svg>
      <figcaption className="legend">
        {present.map((s) => (
          <span key={s.k}><span className="swatch" style={{ background: s.color }} />{s.k}</span>
        ))}
        <span className="muted small">latest: <Link to={`/runs/${points[n - 1]!.jobId}`}>#{points[n - 1]!.number}</Link></span>
      </figcaption>
      <table className="sr">
        <caption>Coverage per job</caption>
        <thead><tr><th>Job</th>{present.map((s) => <th key={s.k}>{s.k}</th>)}</tr></thead>
        <tbody>{points.map((p) => <tr key={p.jobId}><td>#{p.number}</td>{present.map((s) => <td key={s.k}>{pct(p.coverage[s.k])?.toFixed(1) ?? "—"}</td>)}</tr>)}</tbody>
      </table>
    </figure>
  );
}
