import { useState } from "react";
import { useParams } from "react-router-dom";

import { api, fmtBytes, fmtTime, post, useApi } from "../api";
import { useMe } from "../App";
import { ActionButton, Card, Copy, Empty, ErrorBox, Loading, Stat } from "../components/ui";

const ROLES = ["owner", "admin", "engineer", "viewer"];

function ShownOnce({ token, onDone }: { token: string; onDone: () => void }) {
  return (
    <div className="alert ok" role="status">
      <p><b>Copy this token now.</b> It is shown only once and stored only as a hash.</p>
      <pre className="code">{token}</pre>
      <Copy text={token} /> <button className="btn tiny" onClick={onDone}>Done</button>
    </div>
  );
}

export function OrgSettings() {
  const { org } = useParams();
  const { me } = useMe();
  const o = useApi(`/orgs/${org}`, [org]);
  const members = useApi(`/orgs/${org}/members`, [org]);
  const keys = useApi(`/orgs/${org}/api-keys`, [org]);
  const inst = useApi(`/orgs/${org}/github/installations`, [org]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("engineer");
  const [keyName, setKeyName] = useState("CI");
  const [keyRole, setKeyRole] = useState("engineer");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [instId, setInstId] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const myRole = me?.organizations.find((x) => x.slug === org)?.role;
  return (
    <div>
      <h1>Organization settings</h1>
      <ErrorBox error={o.error ?? err} />
      {o.data && (
        <Card title="Plan and quotas">
          <div className="stats">
            <Stat label="Plan" value={o.data.plan?.name ?? o.data.organization.plan} />
            <Stat label="Concurrent tests" value={`${o.data.usage.runningTasks} / ${o.data.plan?.max_concurrent_tasks ?? "—"}`} />
            <Stat label="Concurrent jobs" value={`${o.data.usage.runningJobs} / ${o.data.plan?.max_concurrent_jobs ?? "—"}`} />
            <Stat label="Storage" value={`${fmtBytes(o.data.usage.storageBytes)} / ${fmtBytes(Number(o.data.plan?.artifact_quota_bytes))}`} />
            <Stat label="Max job duration" value={o.data.plan ? `${Math.round(o.data.plan.max_job_seconds / 60)} min` : "—"} sub={o.data.plan ? `≤ ${o.data.plan.max_test_runs_per_job} test runs per job` : ""} />
          </div>
        </Card>
      )}
      <Card title="Members">
        <table className="table">
          <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Since</th><th /></tr></thead>
          <tbody>
            {members.data?.members.map((m: any) => (
              <tr key={m.id}>
                <td>{m.email}</td><td>{m.name}</td>
                <td>
                  <select value={m.role} disabled={m.id === me?.user?.id} aria-label={`Role of ${m.email}`} onChange={async (e) => { try { await api("PATCH", `/orgs/${org}/members/${m.id}`, { role: e.target.value }); members.reload(); } catch (x) { setErr(x); } }}>
                    {ROLES.filter((r) => r !== "owner" || myRole === "owner").map((r) => <option key={r}>{r}</option>)}
                  </select>
                </td>
                <td className="small">{fmtTime(m.created_at)}</td>
                <td>{m.id !== me?.user?.id && <ActionButton kind="danger" confirm={`Remove ${m.email}?`} onClick={async () => { await api("DELETE", `/orgs/${org}/members/${m.id}`); members.reload(); }}>Remove</ActionButton>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <form className="form inline" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { await post(`/orgs/${org}/members`, { email, role }); setEmail(""); members.reload(); } catch (x) { setErr(x); } }}>
          <label>Add existing user by email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label>Role<select value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.filter((r) => r !== "owner").map((r) => <option key={r}>{r}</option>)}</select></label>
          <button className="btn secondary">Add member</button>
        </form>
        <p className="small muted">Owners manage billing and owners; admins manage projects, members and keys; engineers run and debug; viewers read.</p>
      </Card>
      <Card title="API keys (CI)">
        {newKey && <ShownOnce token={newKey} onDone={() => setNewKey(null)} />}
        {keys.data?.apiKeys.length === 0 && <Empty>No API keys.</Empty>}
        <ul className="list compact">
          {keys.data?.apiKeys.map((k: any) => (
            <li key={k.id} className="listrow">
              <span><b>{k.name}</b> <span className="mono small">{k.prefix}…</span> {k.role} · {k.scopes.join(", ")}</span>
              <span className="small muted">{k.revoked_at ? "revoked" : `last used ${fmtTime(k.last_used_at)} · expires ${k.expires_at ? new Date(k.expires_at).toLocaleDateString() : "never"}`}</span>
              {!k.revoked_at && <ActionButton kind="danger" confirm={`Revoke ${k.name}?`} onClick={async () => { await api("DELETE", `/orgs/${org}/api-keys/${k.id}`); keys.reload(); }}>Revoke</ActionButton>}
            </li>
          ))}
        </ul>
        <form className="form inline" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { const r = await post(`/orgs/${org}/api-keys`, { name: keyName, role: keyRole, scopes: keyRole === "viewer" ? ["read"] : ["read", "write"], expiresInDays: 90 }); setNewKey(r.token); keys.reload(); } catch (x) { setErr(x); } }}>
          <label>Name<input value={keyName} onChange={(e) => setKeyName(e.target.value)} required /></label>
          <label>Role<select value={keyRole} onChange={(e) => setKeyRole(e.target.value)}><option>engineer</option><option>viewer</option><option>admin</option></select></label>
          <button className="btn secondary">Create key (90 days)</button>
        </form>
      </Card>
      <Card title="GitHub App installations">
        {inst.data && !inst.data.configured && <p className="small muted">The GitHub App is not configured on this server (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET).</p>}
        {inst.data?.installations.length === 0 && <Empty>No installations claimed.</Empty>}
        <ul className="list compact">{inst.data?.installations.map((i: any) => <li key={i.installation_id}>{i.account_login} <span className="mono small">#{i.installation_id}</span> <span className="small muted">{fmtTime(i.created_at)}</span></li>)}</ul>
        <form className="form inline" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { await post(`/orgs/${org}/github/installations/claim`, { installationId: Number(instId) }); setInstId(""); inst.reload(); } catch (x) { setErr(x); } }}>
          <label>Installation id<input inputMode="numeric" pattern="\d+" value={instId} onChange={(e) => setInstId(e.target.value)} required /></label>
          <button className="btn secondary">Claim installation</button>
        </form>
        <p className="small muted">You can only claim an installation that your linked GitHub account created (log in with GitHub once to link it).</p>
      </Card>
    </div>
  );
}

export function Tokens() {
  const t = useApi("/me/tokens");
  const [name, setName] = useState("cli");
  const [scopes, setScopes] = useState<string[]>(["read", "write"]);
  const [days, setDays] = useState(90);
  const [newTok, setNewTok] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  return (
    <div className="narrow wide">
      <h1>Personal access tokens</h1>
      <p className="muted">For the CLI and scripts. A token acts as you, limited by its scopes and your role in each organization.</p>
      {newTok && <ShownOnce token={newTok} onDone={() => setNewTok(null)} />}
      <ErrorBox error={t.error ?? err} />
      <Card>
        {t.data?.tokens.length === 0 && <Empty>No tokens.</Empty>}
        <ul className="list compact">
          {t.data?.tokens.map((k: any) => (
            <li key={k.id} className="listrow">
              <span><b>{k.name}</b> <span className="mono small">{k.prefix}…</span> {k.scopes.join(", ")}</span>
              <span className="small muted">{k.revoked_at ? "revoked" : `last used ${fmtTime(k.last_used_at)} · expires ${new Date(k.expires_at).toLocaleDateString()}`}</span>
              {!k.revoked_at && <ActionButton kind="danger" onClick={async () => { await api("DELETE", `/me/tokens/${k.id}`); t.reload(); }}>Revoke</ActionButton>}
            </li>
          ))}
        </ul>
        <form className="form inline" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { const r = await post("/me/tokens", { name, scopes, expiresInDays: days }); setNewTok(r.token); t.reload(); } catch (x) { setErr(x); } }}>
          <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
          <fieldset className="inline">
            {["read", "write", "admin"].map((s) => <label key={s} className="check"><input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} /> {s}</label>)}
          </fieldset>
          <label>Expires in (days)<input type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} /></label>
          <button className="btn primary" disabled={!scopes.length}>Create token</button>
        </form>
      </Card>
    </div>
  );
}

const USAGE_LABEL: Record<string, string> = {
  worker_seconds: "Worker time (s)", simulation_seconds: "Simulation time (s)", cpu_seconds: "CPU time (s)",
  artifact_bytes: "Artifacts stored (bytes)", artifact_byte_days: "Storage (byte-days)", ai_tokens_in: "AI tokens in", ai_tokens_out: "AI tokens out",
};

export function Usage() {
  const { org } = useParams();
  const [days, setDays] = useState(30);
  const u = useApi(`/orgs/${org}/usage?days=${days}`, [org, days]);
  return (
    <div>
      <div className="pagehead">
        <h1>Usage</h1>
        <label>Period <select value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label>
      </div>
      <p className="muted small">The metered ledger (one idempotent record per task attempt and artifact). It is the basis for billing; no prices are applied here.</p>
      <ErrorBox error={u.error} />
      {!u.data && !u.error && <Loading />}
      {u.data && (
        <>
          <div className="stats">
            {Object.entries(u.data.totals).map(([k, v]) => <Stat key={k} label={USAGE_LABEL[k] ?? k} value={k.includes("bytes") ? fmtBytes(Number(v)) : Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 })} />)}
            <Stat label="Storage in use" value={`${fmtBytes(u.data.storage.used)} / ${fmtBytes(u.data.storage.quota)}`} />
          </div>
          <Card title="Per day">
            {u.data.daily.length === 0 ? <Empty>No usage in this period.</Empty> : (
              <table className="table small">
                <thead><tr><th>Day</th><th>Kind</th><th>Quantity</th></tr></thead>
                <tbody>{u.data.daily.map((d: any, i: number) => <tr key={i}><td>{new Date(d.day).toLocaleDateString()}</td><td>{USAGE_LABEL[d.kind] ?? d.kind}</td><td>{d.kind.includes("bytes") ? fmtBytes(d.quantity) : d.quantity.toFixed(1)}</td></tr>)}</tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

export function Audit() {
  const { org } = useParams();
  const [before, setBefore] = useState<number | null>(null);
  const [action, setAction] = useState("");
  const a = useApi(`/orgs/${org}/audit?limit=100${before ? `&before=${before}` : ""}${action ? `&action=${encodeURIComponent(action)}` : ""}`, [org, before, action]);
  return (
    <div>
      <div className="pagehead">
        <h1>Audit log</h1>
        <label>Action <input value={action} onChange={(e) => { setAction(e.target.value); setBefore(null); }} placeholder="e.g. job.create" /></label>
      </div>
      <ErrorBox error={a.error} />
      <Card>
        {a.data?.events.length === 0 && <Empty>No events.</Empty>}
        {a.data && a.data.events.length > 0 && (
          <table className="table small">
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>IP</th><th>Details</th></tr></thead>
            <tbody>{a.data.events.map((e: any) => <tr key={e.id}><td>{new Date(e.created_at).toLocaleString()}</td><td>{e.actor_label}</td><td className="mono">{e.action}</td><td className="small">{e.target_type} {e.target_id?.slice?.(0, 8)}</td><td className="small">{e.ip}</td><td className="small mono">{e.metadata ? JSON.stringify(e.metadata).slice(0, 160) : ""}</td></tr>)}</tbody>
          </table>
        )}
        {a.data?.nextBefore && <button className="btn tiny" onClick={() => setBefore(a.data.nextBefore)}>Older</button>}
      </Card>
    </div>
  );
}

export function Workers() {
  const w = useApi("/workers");
  return (
    <div>
      <h1>Workers</h1>
      <ErrorBox error={w.error} />
      {w.data && (
        <>
          <div className="stats">
            <Stat label="Online workers" value={w.data.online} sub="heartbeat within 60 s" />
            <Stat label="CPU capacity" value={w.data.capacityCpus} />
            <Stat label="Running tests" value={w.data.running} />
            <Stat label="Queue depth (all tenants)" value={w.data.queueDepth} />
          </div>
          {w.data.workers ? (
            <Card title="Pool">
              <table className="table small">
                <thead><tr><th>Name</th><th>Sandbox</th><th>CPUs</th><th>Memory</th><th>Running</th><th>Toolchain</th><th>Last heartbeat</th></tr></thead>
                <tbody>{w.data.workers.map((x: any) => <tr key={x.id}><td>{x.name}</td><td>{x.sandbox}</td><td>{x.cpus}</td><td>{fmtBytes(x.memory_mb * 1024 * 1024)}</td><td>{x.running}</td><td className="small mono">{x.toolchain?.verilator ?? ""}</td><td>{fmtTime(x.last_heartbeat_at)}</td></tr>)}</tbody>
              </table>
            </Card>
          ) : (
            <p className="small muted">Individual workers are visible to platform administrators only.</p>
          )}
        </>
      )}
    </div>
  );
}
