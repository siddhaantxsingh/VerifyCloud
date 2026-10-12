import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { api, fmtPct, fmtTime, pct, post, useApi, useEvents } from "../api";
import { ActionButton, Card, Copy, Crumbs, Empty, ErrorBox, Loading, State } from "../components/ui";
import { CoverageChart } from "../components/CoverageChart";
import { detectionInput, fromDirectoryInput, tarGz, type PickedFile } from "../tar";

const canWrite = (role?: string) => ["owner", "admin", "engineer"].includes(role ?? "");
const canAdmin = (role?: string) => ["owner", "admin"].includes(role ?? "");

export function ProjectPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const p = useApi(`/projects/${id}`, [id]);
  const regs = useApi(`/projects/${id}/regressions`, [id]);
  const jobs = useApi(`/projects/${id}/jobs?limit=25`, [id]);
  const cov = useApi(`/projects/${id}/coverage?limit=50`, [id]);
  const [testHist, setTestHist] = useState<string | null>(null);
  useEvents(id ? { project: id } : null, (e) => {
    if (["JOB_QUEUED", "JOB_STARTED", "JOB_COMPLETED"].includes(e.type)) {
      void jobs.reload();
      void regs.reload();
      if (e.type === "JOB_COMPLETED") void cov.reload();
    }
  });
  if (p.error) return <ErrorBox error={p.error} />;
  if (!p.data) return <Loading />;
  const { project, repository, latestSnapshot, failing, ai } = p.data;
  const role = project.role as string;
  const run = async (regression: string) => {
    const r = await post(`/projects/${id}/jobs`, { regression });
    nav(`/runs/${r.job.id}`);
  };
  return (
    <div>
      <Crumbs items={[{ label: "Projects" }, { label: project.name }]} />
      <div className="pagehead">
        <div>
          <h1>{project.name}</h1>
          <p className="muted">{project.description}</p>
        </div>
        <div className="actions">
          <Link className="btn secondary" to={`/projects/${id}/compare`}>Compare branches</Link>
          {canAdmin(role) && <Link className="btn secondary" to={`/projects/${id}/settings`}>Settings</Link>}
        </div>
      </div>
      <div className="grid3">
        <Card title="Source">
          {repository ? (
            <p>GitHub <b>{repository.full_name}</b> (default branch {repository.default_branch}). Pushes and pull requests start runs{project.pr_checks ? " and report checks" : ""}.</p>
          ) : (
            <p>No repository connected. Runs use uploaded snapshots{latestSnapshot ? <> — latest {fmtTime(latestSnapshot.created_at)}</> : null}.</p>
          )}
          {canWrite(role) && !project.is_demo && <SnapshotUpload projectId={id!} onDone={() => p.reload()} />}
        </Card>
        <Card title="Currently failing">
          {failing?.length ? (
            <ul className="list compact">
              {failing.map((f: any) => (
                <li key={`${f.test_name}-${f.seed}`}>
                  <button className="link" onClick={() => setTestHist(f.test_name)}>{f.test_name}</button> seed {f.seed}{" "}
                  <Link className="small" to={`/tasks/${f.id}`}>latest failure</Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nothing failing in the latest runs.</p>
          )}
        </Card>
        <Card title="Failure analysis">
          <p className="small">{ai?.dataHandling}</p>
          <p className="small muted">Provider: {ai?.provider}{ai?.model ? ` (${ai.model})` : ""}{ai?.available === false ? " — not configured on this server" : ""}</p>
        </Card>
      </div>

      <Card title="Regressions">
        <ErrorBox error={regs.error} />
        {regs.data?.regressions.length === 0 && <Empty>No regressions defined yet: upload sources with a verifycloud.yaml.</Empty>}
        {regs.data && regs.data.regressions.length > 0 && (
          <table className="table">
            <thead><tr><th>Regression</th><th>Tests</th><th>Last result</th><th>Passed</th><th>Line</th><th>Branch</th><th>Runs</th><th /></tr></thead>
            <tbody>
              {regs.data.regressions.map((r: any) => (
                <tr key={r.name}>
                  <td className="strong">{r.name}</td>
                  <td className="small">{r.tests.map((t: string) => <button key={t} className="link chip" onClick={() => setTestHist(t)}>{t}</button>)}</td>
                  <td>{r.last_job_id ? <Link to={`/runs/${r.last_job_id}`}><State s={r.state} /></Link> : <State s={null} />}</td>
                  <td>{r.summary ? `${r.summary.passed}/${r.summary.tests}` : "—"}</td>
                  <td>{fmtPct(pct(r.coverage?.line))}</td>
                  <td>{fmtPct(pct(r.coverage?.branch))}</td>
                  <td>{r.runs}</td>
                  <td>{canWrite(role) && <ActionButton kind="primary" onClick={() => run(r.name)}>Run</ActionButton>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {testHist && <TestHistory projectId={id!} name={testHist} onClose={() => setTestHist(null)} />}

      <div className="grid2">
        <Card title="Coverage history">
          {cov.data?.history.length ? <CoverageChart points={cov.data.history} /> : <Empty>No merged coverage yet.</Empty>}
        </Card>
        <Card title="Recent runs">
          {jobs.data?.jobs.length === 0 && <Empty>No runs yet.</Empty>}
          <ul className="list">
            {jobs.data?.jobs.map((j: any) => (
              <li key={j.id} className="listrow">
                <div>
                  <Link to={`/runs/${j.id}`} className="strong">#{j.number} {j.regression}</Link>
                  <div className="small muted">{j.trigger}{j.pr_number ? ` · PR #${j.pr_number}` : ""} · {j.commit_sha ? `${j.branch} @ ${j.commit_sha.slice(0, 8)}` : j.branch} · {fmtTime(j.created_at)}{j.patch_id ? " · patch verification" : ""}</div>
                </div>
                <div className="right">
                  <State s={j.state} />
                  {j.summary?.tests ? <div className="small muted">{j.summary.passed ?? 0}/{j.summary.tests}</div> : null}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <CliHint projectId={id!} />
    </div>
  );
}

function TestHistory({ projectId, name, onClose }: { projectId: string; name: string; onClose: () => void }) {
  const h = useApi(`/projects/${projectId}/tests/${encodeURIComponent(name)}/history?limit=50`, [name]);
  const rows = h.data?.history ?? [];
  const failRate = rows.length ? rows.filter((r: any) => r.state !== "PASSED").length / rows.length : null;
  return (
    <Card title={<>Test history: <span className="mono">{name}</span></>} actions={<button className="btn tiny" onClick={onClose}>Close</button>}>
      {h.loading && !h.data && <Loading />}
      {rows.length === 0 && h.data && <Empty>No finished runs of this test yet.</Empty>}
      {rows.length > 0 && (
        <>
          <div className="histstrip" aria-label="Recent results, oldest to newest">
            {[...rows].reverse().map((r: any) => (
              <Link key={r.id} to={`/tasks/${r.id}`} className={`histcell ${r.state === "PASSED" ? (r.flaky ? "warn" : "ok") : "bad"}`} title={`#${r.number} seed ${r.seed}: ${r.state}${r.flaky ? " (flaky)" : ""}`} />
            ))}
          </div>
          <p className="small muted">{rows.length} recent runs, failure rate {fmtPct(failRate === null ? null : failRate * 100)}. Amber = passed after a retry (flaky).</p>
        </>
      )}
    </Card>
  );
}

function SnapshotUpload({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [picked, setPicked] = useState<{ files: PickedFile[]; skipped: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [result, setResult] = useState<any>(null);
  return (
    <div className="upload">
      <label className="btn secondary small filebtn">
        Choose project folder…
        <input
          type="file"
          // @ts-expect-error non-standard but widely supported directory picker
          webkitdirectory=""
          multiple
          onChange={(e) => e.target.files && setPicked(fromDirectoryInput(e.target.files))}
        />
      </label>
      {picked && (
        <div className="small">
          {picked.files.length} files selected{picked.skipped ? `, ${picked.skipped} skipped (VCS, build outputs, waveforms)` : ""}.{" "}
          {!picked.files.some((f) => f.path === "verifycloud.yaml") && <span className="warntext">No verifycloud.yaml at the top level — runs need one (see Settings → Detect).</span>}
          <div>
            <button
              className="btn primary small"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  const gz = await tarGz(picked.files);
                  const r = await api("POST", `/projects/${projectId}/snapshots`, gz);
                  setResult(r);
                  setPicked(null);
                  onDone();
                } catch (x) {
                  setErr(x);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Uploading…" : "Upload snapshot"}
            </button>
          </div>
        </div>
      )}
      {result && (
        <div className={`alert ${result.config.ok ? "ok" : "warn"}`}>
          Snapshot uploaded ({result.snapshot.fileCount} files).{" "}
          {result.config.ok ? <>Regressions: {result.config.regressions.join(", ")}.</> : <>Configuration problems: {result.config.issues.map((i: any) => `${i.line ? `line ${i.line}: ` : ""}${i.message}`).join("; ")}</>}
        </div>
      )}
      <ErrorBox error={err} />
    </div>
  );
}

function CliHint({ projectId }: { projectId: string }) {
  const cmd = `verifycloud run --project ${projectId} --regression smoke --wait`;
  return (
    <Card title="From the command line">
      <p className="small">Create a personal access token under <Link to="/me/tokens">Tokens</Link>, then:</p>
      <pre className="code">verifycloud login --api {window.location.origin}{"\n"}{cmd}</pre>
      <Copy text={cmd} />
    </Card>
  );
}

export function NewProject() {
  const { org } = useParams();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [err, setErr] = useState<unknown>(null);
  return (
    <div className="narrow">
      <Crumbs items={[{ to: `/o/${org}`, label: org }, { label: "New project" }]} />
      <h1>New project</h1>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await post(`/orgs/${org}/projects`, { name, slug, description: description || undefined });
            nav(`/projects/${r.project.id}/settings?new=1`);
          } catch (x) {
            setErr(x);
          }
        }}
      >
        <label>Name<input value={name} onChange={(e) => { setName(e.target.value); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)); }} required /></label>
        <label>Slug<input value={slug} onChange={(e) => setSlug(e.target.value)} required pattern="[a-z0-9][a-z0-9-]{0,62}" /></label>
        <label>Description <span className="muted small">(optional)</span><input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} /></label>
        <ErrorBox error={err} />
        <button className="btn primary">Create project</button>
      </form>
    </div>
  );
}

export function ProjectSettings() {
  const { id } = useParams();
  const p = useApi(`/projects/${id}`, [id]);
  if (p.error) return <ErrorBox error={p.error} />;
  if (!p.data) return <Loading />;
  const project = p.data.project;
  return (
    <div>
      <Crumbs items={[{ to: `/projects/${id}`, label: project.name }, { label: "Settings" }]} />
      <h1>Project settings</h1>
      <Detect projectId={id!} />
      <Repository projectId={id!} orgId={project.org_id} repository={p.data.repository} onChange={() => p.reload()} />
      <GeneralSettings project={project} onSaved={() => p.reload()} />
      <Secrets projectId={id!} />
      <Notifications projectId={id!} />
      <Danger projectId={id!} name={project.name} />
    </div>
  );
}

function Detect({ projectId }: { projectId: string }) {
  const [report, setReport] = useState<any>(null);
  const [text, setText] = useState("");
  const [check, setCheck] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  return (
    <Card title="Detect project structure and write verifycloud.yaml">
      <p className="small">Pick your project folder. Only file names and the first 64 KiB of HDL and script files are sent for detection; nothing is uploaded or stored until you upload a snapshot.</p>
      <label className="btn secondary small filebtn">
        Choose folder…
        <input
          type="file"
          // @ts-expect-error non-standard directory picker
          webkitdirectory=""
          multiple
          onChange={async (e) => {
            if (!e.target.files) return;
            setErr(null);
            try {
              const { files } = fromDirectoryInput(e.target.files);
              const r = await post(`/projects/${projectId}/detect`, { files: await detectionInput(files) });
              setReport(r);
              setText(r.proposedConfig ?? "");
            } catch (x) {
              setErr(x);
            }
          }}
        />
      </label>
      <ErrorBox error={err} />
      {report && (
        <div className="detect">
          <p className="small">
            {report.hdlFiles.sv + report.hdlFiles.v} HDL files · {report.modules.length} modules · {report.packages.length} packages · {report.interfaces.length} interfaces
            {report.uvm ? " · UVM detected" : ""}{report.hasConfig ? " · verifycloud.yaml present" : ""}
          </p>
          {report.findings.length > 0 && <ul className="small">{report.findings.map((f: string, i: number) => <li key={i}>{f}</li>)}</ul>}
          {report.questions.length > 0 && (
            <div className="alert warn"><b>Decisions for you:</b><ul>{report.questions.map((q: string, i: number) => <li key={i}>{q}</li>)}</ul></div>
          )}
        </div>
      )}
      <label className="block">
        verifycloud.yaml
        <textarea className="mono" rows={14} value={text} onChange={(e) => { setText(e.target.value); setCheck(null); }} placeholder="Paste or detect a configuration" spellCheck={false} />
      </label>
      <div className="actions">
        <ActionButton onClick={async () => setCheck(await post(`/projects/${projectId}/config/validate`, { text }))}>Validate</ActionButton>
        {text && <button className="btn secondary" onClick={() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/yaml" })); a.download = "verifycloud.yaml"; a.click(); }}>Download</button>}
      </div>
      {check && (check.ok ? <div className="alert ok">Valid: tests {check.tests.join(", ")}; regressions {check.regressions.join(", ")}.</div> : (
        <div className="alert bad"><ul>{check.issues.map((i: any, n: number) => <li key={n}>{i.line ? `line ${i.line}: ` : ""}{i.message}</li>)}</ul></div>
      ))}
      <p className="small muted">Commit the file to your repository (or include it in the folder you upload). Only Verilator is supported by this deployment.</p>
    </Card>
  );
}

function Repository({ projectId, repository, onChange }: { projectId: string; orgId: string; repository: any; onChange: () => void }) {
  const [fullName, setFullName] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [branch, setBranch] = useState("main");
  const [err, setErr] = useState<unknown>(null);
  return (
    <Card title="GitHub repository">
      {repository ? (
        <>
          <p>Connected to <b>{repository.full_name}</b> via installation {repository.installation_id}.</p>
          <ActionButton kind="danger" confirm="Disconnect the repository? Runs will no longer be triggered by pushes." onClick={async () => { await api("DELETE", `/projects/${projectId}/repository`); onChange(); }}>Disconnect</ActionButton>
        </>
      ) : (
        <form
          className="form inline"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            try {
              await post(`/projects/${projectId}/repository`, { fullName, installationId: Number(installationId), defaultBranch: branch });
              onChange();
            } catch (x) {
              setErr(x);
            }
          }}
        >
          <p className="small">Install the VerifyCloud GitHub App on the repository, claim the installation in organization settings, then connect it here. The app only receives access to repositories you select.</p>
          <label>Repository<input placeholder="owner/repo" value={fullName} onChange={(e) => setFullName(e.target.value)} required pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+" /></label>
          <label>Installation id<input inputMode="numeric" value={installationId} onChange={(e) => setInstallationId(e.target.value)} required pattern="\d+" /></label>
          <label>Default branch<input value={branch} onChange={(e) => setBranch(e.target.value)} /></label>
          <button className="btn primary">Connect</button>
          <ErrorBox error={err} />
        </form>
      )}
    </Card>
  );
}

function GeneralSettings({ project, onSaved }: { project: any; onSaved: () => void }) {
  const [ai, setAi] = useState(project.ai_settings ?? { provider: "heuristic", allowExternal: false });
  const [prChecks, setPrChecks] = useState<boolean>(project.pr_checks);
  const [maxConcurrency, setMaxConcurrency] = useState<number>(project.max_concurrency);
  const [retention, setRetention] = useState<Record<string, number>>(project.retention);
  const [saved, setSaved] = useState(false);
  return (
    <Card title="Execution, retention and AI">
      <div className="form">
        <label>Max concurrent tests<input type="number" min={1} max={256} value={maxConcurrency} onChange={(e) => setMaxConcurrency(Number(e.target.value))} /></label>
        <label className="check"><input type="checkbox" checked={prChecks} onChange={(e) => setPrChecks(e.target.checked)} /> Report GitHub checks on pull requests</label>
        <fieldset>
          <legend>Retention (days; capped by your plan)</legend>
          <div className="inline">
            {Object.keys(retention).map((k) => (
              <label key={k}>{k}<input type="number" min={1} max={3650} value={retention[k]} onChange={(e) => setRetention({ ...retention, [k]: Number(e.target.value) })} /></label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Failure analysis provider</legend>
          <label><select value={ai.provider} onChange={(e) => setAi({ ...ai, provider: e.target.value })}>
            <option value="heuristic">Rule-based (nothing leaves the deployment)</option>
            <option value="local">Local model inside the deployment</option>
            <option value="openai">External OpenAI-compatible API</option>
          </select></label>
          {ai.provider === "openai" && (
            <label className="check"><input type="checkbox" checked={ai.allowExternal} onChange={(e) => setAi({ ...ai, allowExternal: e.target.checked })} /> I allow sending redacted excerpts of failing runs (log, relevant source lines, waveform window) to the external provider</label>
          )}
        </fieldset>
        <ActionButton kind="primary" onClick={async () => { await api("PATCH", `/projects/${project.id}`, { aiSettings: ai, prChecks, maxConcurrency, retention }); setSaved(true); onSaved(); }}>Save</ActionButton>
        {saved && <span className="small muted">Saved.</span>}
      </div>
    </Card>
  );
}

function Secrets({ projectId }: { projectId: string }) {
  const s = useApi(`/projects/${projectId}/secrets`, [projectId]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  return (
    <Card title="Secrets">
      <p className="small">Encrypted at rest (AES-256-GCM). Values are never shown again and are redacted from logs and AI context. Simulations do not receive secrets.</p>
      <ErrorBox error={s.error} />
      <ul className="list compact">
        {s.data?.secrets.map((x: any) => (
          <li key={x.name} className="listrow">
            <span className="mono">{x.name}</span>
            <span className="small muted">updated {fmtTime(x.updated_at)}</span>
            <ActionButton kind="danger" confirm={`Delete secret ${x.name}?`} onClick={async () => { await api("DELETE", `/projects/${projectId}/secrets/${x.name}`); s.reload(); }}>Delete</ActionButton>
          </li>
        ))}
      </ul>
      <form className="form inline" onSubmit={async (e) => { e.preventDefault(); await api("PUT", `/projects/${projectId}/secrets/${name}`, { value }); setName(""); setValue(""); s.reload(); }}>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value.toUpperCase())} pattern="[A-Z][A-Z0-9_]{0,63}" required /></label>
        <label>Value<input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} required /></label>
        <button className="btn secondary">Save secret</button>
      </form>
    </Card>
  );
}

const EVENTS = ["regression_failed", "regression_passed", "coverage_dropped", "worker_failure", "quota_exceeded"];
function Notifications({ projectId }: { projectId: string }) {
  const n = useApi(`/projects/${projectId}/notifications`, [projectId]);
  const [kind, setKind] = useState<"email" | "webhook">("email");
  const [target, setTarget] = useState("");
  const [secret, setSecret] = useState("");
  const [events, setEvents] = useState<string[]>(["regression_failed"]);
  const [err, setErr] = useState<unknown>(null);
  return (
    <Card title="Notifications">
      <ErrorBox error={n.error} />
      <ul className="list compact">
        {n.data?.channels.map((c: any) => (
          <li key={c.id} className="listrow">
            <span>{c.kind}: <span className="mono">{c.target}</span></span>
            <span className="small muted">{c.events.join(", ")}</span>
            <ActionButton kind="danger" onClick={async () => { await api("DELETE", `/projects/${projectId}/notifications/${c.id}`); n.reload(); }}>Remove</ActionButton>
          </li>
        ))}
      </ul>
      {n.data?.recentDeliveries?.length > 0 && (
        <details>
          <summary className="small">Recent deliveries</summary>
          <table className="table small">
            <thead><tr><th>When</th><th>Channel</th><th>Event</th><th>Status</th><th>Attempts</th><th>Error</th></tr></thead>
            <tbody>{n.data.recentDeliveries.map((d: any) => <tr key={d.id}><td>{fmtTime(d.created_at)}</td><td>{d.kind}</td><td>{d.event}</td><td>{d.status}</td><td>{d.attempts}</td><td className="small">{d.last_error ?? ""}</td></tr>)}</tbody>
          </table>
        </details>
      )}
      <form
        className="form inline"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          try {
            await post(`/projects/${projectId}/notifications`, { kind, target, events, ...(kind === "webhook" && secret ? { secret } : {}) });
            setTarget("");
            setSecret("");
            n.reload();
          } catch (x) {
            setErr(x);
          }
        }}
      >
        <label>Kind<select value={kind} onChange={(e) => setKind(e.target.value as "email" | "webhook")}><option value="email">Email</option><option value="webhook">Webhook (HTTPS, signed)</option></select></label>
        <label>{kind === "email" ? "Address" : "URL"}<input value={target} onChange={(e) => setTarget(e.target.value)} required /></label>
        {kind === "webhook" && <label>Signing secret <span className="muted small">(≥16 chars)</span><input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} minLength={16} /></label>}
        <fieldset className="inline">
          {EVENTS.map((ev) => (
            <label key={ev} className="check"><input type="checkbox" checked={events.includes(ev)} onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))} /> {ev.replace("_", " ")}</label>
          ))}
        </fieldset>
        <button className="btn secondary" disabled={!events.length}>Add channel</button>
        <ErrorBox error={err} />
      </form>
    </Card>
  );
}

function Danger({ projectId, name }: { projectId: string; name: string }) {
  const nav = useNavigate();
  return (
    <Card title="Danger zone" className="danger">
      <p className="small">Deletes the project, its runs, logs, waveforms, coverage and stored objects. This cannot be undone.</p>
      <ActionButton
        kind="danger"
        confirm={`Delete project "${name}" and all of its data?`}
        onClick={async () => {
          await api("DELETE", `/projects/${projectId}`);
          nav("/");
        }}
      >
        Delete project
      </ActionButton>
    </Card>
  );
}
