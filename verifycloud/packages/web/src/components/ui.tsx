import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { ApiError, fmtPct, pct, type Cov } from "../api";

const STATE_CLASS: Record<string, string> = {
  SUCCEEDED: "ok", PASSED: "ok",
  FAILED: "bad", ERROR: "bad",
  TIMED_OUT: "warn", RESOURCE_EXCEEDED: "warn",
  CANCELLED: "muted", SKIPPED: "muted", BLOCKED: "muted",
  RUNNING: "run", QUEUED: "queue",
};

export function State({ s }: { s: string | null | undefined }) {
  if (!s) return <span className="badge muted">no runs</span>;
  return <span className={`badge cap ${STATE_CLASS[s] ?? "muted"}`}>{s.replace("_", " ").toLowerCase()}</span>;
}

export function CovBar({ label, c }: { label: string; c?: { covered: number; total: number } }) {
  const v = pct(c);
  return (
    <div className="covbar" title={c ? `${c.covered} of ${c.total}` : "not measured"}>
      <span className="covlabel">{label}</span>
      <span className="track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v ?? undefined} aria-label={`${label} coverage`}>
        <span className="fill" style={{ width: `${v ?? 0}%` }} />
      </span>
      <span className="covval">{fmtPct(v)}</span>
      <span className="covraw">{c ? `${c.covered}/${c.total}` : ""}</span>
    </div>
  );
}

export function CovSummary({ cov }: { cov?: Cov | null }) {
  if (!cov || Object.keys(cov).length === 0) return <p className="muted">No coverage recorded.</p>;
  return (
    <div className="covsummary">
      {(["line", "branch", "toggle", "functional"] as const).filter((k) => cov[k]).map((k) => <CovBar key={k} label={k} c={cov[k]} />)}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  return (
    <div className="alert bad" role="alert">
      <strong>{e.code ?? "Error"}</strong> {e.message}
      {e.requestId && <span className="muted small"> (request {e.requestId})</span>}
      {Array.isArray((e.details as any)?.issues) && (
        <ul>
          {(e.details as any).issues.map((i: any, n: number) => (
            <li key={n}>{i.line ? `line ${i.line}: ` : ""}{i.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const Loading = ({ what = "Loading" }: { what?: string }) => <p className="muted" aria-live="polite">{what}…</p>;

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ""}`}>
      {(title || actions) && (
        <header className="cardhead">
          {title && <h2>{title}</h2>}
          {actions && <div className="actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="statlabel">{label}</div>
      <div className="statvalue">{value}</div>
      {sub && <div className="statsub">{sub}</div>}
    </div>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: ReactNode }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? "tab active" : "tab"} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** A button that runs an async action, shows progress and surfaces errors. */
export function ActionButton({ onClick, children, kind = "secondary", confirm, disabled }: { onClick: () => Promise<unknown>; children: ReactNode; kind?: "primary" | "secondary" | "danger"; confirm?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <span className="actionbtn">
      <button
        className={`btn ${kind}`}
        disabled={busy || disabled}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          setBusy(true);
          setErr(null);
          try {
            await onClick();
          } catch (e) {
            setErr(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Working…" : children}
      </button>
      {err ? <ErrorBox error={err} /> : null}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Crumbs({ items }: { items: { to?: string; label: ReactNode }[] }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {items.map((i, n) => (
        <span key={n}>
          {n > 0 && <span className="sep">/</span>}
          {i.to ? <Link to={i.to}>{i.label}</Link> : <span aria-current="page">{i.label}</span>}
        </span>
      ))}
    </nav>
  );
}

export function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="btn tiny" onClick={() => navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}>
      {done ? "Copied" : "Copy"}
    </button>
  );
}
