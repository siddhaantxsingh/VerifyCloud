import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { post } from "../api";
import { useMe } from "../App";
import { safeNext } from "../nav";

function AuthFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="authpage">
      <div className="authcard">
        <div className="brand big">
          <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="var(--accent)" /><path d="M7 17l6 6L25 9" stroke="white" strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          VerifyCloud
        </div>
        <p className="muted">CI/CD, regression testing, coverage and AI-assisted debugging for RTL.</p>
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}



export function Login() {
  const { me, refresh } = useMe();
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const done = async () => {
    await refresh();
    window.location.replace(safeNext(params.get("next"), window.location.origin));
  };
  return (
    <AuthFrame title="Log in">
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await post("/auth/login", { email, password });
            await done();
          } catch (x) {
            setErr((x as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {err && <div className="alert bad" role="alert">{err}</div>}
        <button className="btn primary" disabled={busy}>{busy ? "Logging in…" : "Log in"}</button>
      </form>
      <div className="authalt">
        <a className="btn secondary" href="/api/v1/auth/github/start">Continue with GitHub</a>
        <button
          className="btn secondary"
          onClick={async () => {
            try {
              await post("/auth/demo");
              await done();
            } catch (x) {
              setErr((x as any).status === 404 ? "The public demo is not enabled on this server." : (x as Error).message);
            }
          }}
        >
          Try the demo
        </button>
      </div>
      <p className="small">No account? <Link to="/register">Create one</Link></p>
      {me && <p className="small">Already logged in.</p>}
    </AuthFrame>
  );
}

export function Register() {
  const { refresh } = useMe();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [verify, setVerify] = useState(false);
  return (
    <AuthFrame title="Create an account">
      {verify ? (
        <p>Check your inbox: we sent a verification link to <b>{email}</b>.</p>
      ) : (
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            try {
              const r = await post<any>("/auth/register", { name, email, password });
              if (r.verificationRequired) setVerify(true);
              else {
                await refresh();
                window.location.replace("/");
              }
            } catch (x) {
              setErr((x as Error).message);
            }
          }}
        >
          <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} /></label>
          <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label>Password <span className="muted small">(at least 10 characters)</span><input type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          {err && <div className="alert bad" role="alert">{err}</div>}
          <button className="btn primary">Create account</button>
        </form>
      )}
      <p className="small">Have an account? <Link to="/login">Log in</Link></p>
    </AuthFrame>
  );
}
