import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { fmtBytes, fmtDuration, get, post, TERMINAL, useApi, useEvents } from "../api";
import { useMe } from "../App";
import { ActionButton, Card, Copy, CovSummary, Crumbs, Empty, ErrorBox, Loading, State, Tabs } from "../components/ui";
import { Waveform } from "../components/Waveform";

export function TaskPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const t = useApi(`/tasks/${id}`, [id]);
  const [tab, setTab] = useState<string | null>(null);
  useEvents(t.data && !TERMINAL.includes(t.data.job.state) ? { job: t.data.job.id } : null, (e) => {
    if (e.data?.taskId === id || e.type === "JOB_COMPLETED") void t.reload();
  });
  if (t.error) return <ErrorBox error={t.error} />;
  if (!t.data) return <Loading />;
  const { task, job, artifacts, assertions, coverage, analyses } = t.data;
  const wave = artifacts.find((a: any) => a.kind === "waveform");
  const failed = ["FAILED", "ERROR", "TIMED_OUT", "RESOURCE_EXCEEDED"].includes(task.state);
  const current = tab ?? (failed && task.kind === "test" ? "analysis" : "log");
  const focus = params.get("t") ? Number(params.get("t")) : assertions[0]?.sim_time ? Number(assertions[0].sim_time) : null;
  const r = task.result ?? {};
  // signals the analysis looked at (header row of its waveform evidence table)
  const waveEv = analyses?.find((a: any) => a.result?.evidence)?.result.evidence.find((e: any) => e.kind === "waveform")?.text as string | undefined;
  const highlight = waveEv ? (waveEv.split("\n").find((l) => l.startsWith("time(")) ?? "").split("|").slice(1).map((x) => x.trim()).filter(Boolean) : [];
  return (
    <div>
      <Crumbs items={[{ to: `/projects/${job.project_id}`, label: "Project" }, { to: `/runs/${job.id}`, label: `Run #${job.number}` }, { label: task.kind === "build" ? "Build" : `${task.test_name} / seed ${task.seed}` }]} />
      <div className="pagehead">
        <div>
          <h1>{task.kind === "build" ? "Build" : <><span className="mono">{task.test_name}</span> seed {task.seed}</>} <State s={task.state} /></h1>
          <p className="muted small">
            {fmtDuration(task.duration_ms)} · exit code {task.exit_code ?? "—"} · attempt {task.attempt}/{task.max_attempts} · {task.cpu} CPU, {task.memory_mb} MiB, timeout {task.timeout_seconds} s
            {r.simTime != null ? ` · simulated to ${r.simTime}` : ""}
            {r.flaky ? " · flaky (passed after a retry)" : ""}
          </p>
          {task.error && <div className="alert bad">{task.error}</div>}
          {r.summary && <p>{r.summary}</p>}
          {r.checkFailures?.length > 0 && (
            <div className="alert bad small"><b>Self-check failures</b><ul>{r.checkFailures.slice(0, 10).map((c: string, i: number) => <li key={i} className="mono">{c}</li>)}</ul></div>
          )}
          {r.notes?.length > 0 && <ul className="small muted">{r.notes.map((n: string, i: number) => <li key={i}>{n}</li>)}</ul>}
        </div>
      </div>
      <Tabs
        value={current}
        onChange={setTab}
        tabs={[
          ...(task.kind === "test" && failed ? [{ id: "analysis", label: "Failure analysis" }] : []),
          { id: "log", label: "Log" },
          ...(task.kind === "test" ? [{ id: "assertions", label: `Assertions (${assertions.length})` }] : []),
          ...(wave ? [{ id: "wave", label: "Waveform" }] : []),
          ...(coverage ? [{ id: "coverage", label: "Coverage" }] : []),
          { id: "artifacts", label: `Artifacts (${artifacts.length})` },
          { id: "reproduce", label: "Reproduce" },
        ]}
      />
      {current === "analysis" && <Analysis taskId={id!} jobId={job.id} existing={analyses} onWave={() => setTab("wave")} onAnalyzed={() => void t.reload()} />}
      {current === "log" && <LogViewer taskId={id!} />}
      {current === "assertions" && (
        <Card>
          {assertions.length === 0 ? <Empty>No assertion failures in this run.</Empty> : (
            <table className="table">
              <thead><tr><th>Assertion</th><th>Time</th><th>Location</th><th>Message</th></tr></thead>
              <tbody>{assertions.map((a: any, i: number) => <tr key={i}><td className="mono">{a.name}<div className="small muted">{a.scope}</div></td><td>{a.sim_time}</td><td className="small">{a.file}:{a.line}</td><td>{a.message}</td></tr>)}</tbody>
            </table>
          )}
        </Card>
      )}
      {current === "wave" && wave && <Card><Waveform artifactId={wave.id} focusTime={focus} highlight={highlight} /></Card>}
      {current === "coverage" && <Card title="Coverage of this run"><CovSummary cov={coverage} /></Card>}
      {current === "artifacts" && <Artifacts artifacts={artifacts} />}
      {current === "reproduce" && <Reproduce taskId={id!} />}
    </div>
  );
}

function LogViewer({ taskId }: { taskId: string }) {
  const [q, setQ] = useState("");
  const [severity, setSeverity] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const LIMIT = 500;
  useEffect(() => {
    const h = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ offset: String(offset), limit: String(LIMIT) });
        if (q) qs.set("q", q);
        if (severity) qs.set("severity", severity);
        setData(await get(`/tasks/${taskId}/log?${qs}`));
        setErr(null);
      } catch (e) {
        setErr(e);
      }
    }, 200);
    return () => clearTimeout(h);
  }, [taskId, q, severity, offset]);
  const cls = (t: string) => (/%Error|%Fatal|Assertion failed|VC_CHECK FAIL|VC_RESULT FAIL|error:/i.test(t) ? "err" : /%Warning|warning:/i.test(t) ? "warnl" : /VC_RESULT PASS/.test(t) ? "okl" : "");
  return (
    <Card>
      <div className="filters">
        <label>Search <input value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} placeholder="text in the log" /></label>
        <label>Severity <select value={severity} onChange={(e) => { setSeverity(e.target.value); setOffset(0); }}><option value="">all lines</option><option value="error">errors</option><option value="warning">warnings</option></select></label>
        {data?.artifactId && <a className="btn tiny" href={`/api/v1/artifacts/${data.artifactId}/download`}>Download log</a>}
      </div>
      <ErrorBox error={err} />
      {data && data.total === 0 && <Empty>{data.artifactId ? "No matching lines." : "No log was stored for this run."}</Empty>}
      {data?.truncated && <div className="alert warn small">The worker kept the first part of this log; {fmtBytes(data.truncatedBytes)} more output was produced and not stored.</div>}
      {data && data.total > 0 && (
        <>
          <pre className="log" tabIndex={0} aria-label="Log output">
            {data.lines.map((l: any) => (
              <div key={l.n} className={`logline ${cls(l.text)}`}><span className="ln">{l.n}</span>{l.text}</div>
            ))}
          </pre>
          <div className="pager small">
            {q || severity ? `${data.total} matching of ${data.totalLines} lines` : `${data.totalLines} lines`}
            {offset > 0 && <button className="btn tiny" onClick={() => setOffset(Math.max(0, offset - LIMIT))}>Previous</button>}
            {offset + LIMIT < data.total && <button className="btn tiny" onClick={() => setOffset(offset + LIMIT)}>Next</button>}
          </div>
        </>
      )}
    </Card>
  );
}

function Analysis({ taskId, jobId, existing, onWave, onAnalyzed }: { taskId: string; jobId: string; existing: any[]; onWave: () => void; onAnalyzed: () => void }) {
  const { me } = useMe();
  const nav = useNavigate();
  const preview = useApi(`/tasks/${taskId}/analysis/preview`, [taskId]);
  const latest = existing?.find((a: any) => a.status === "succeeded");
  const [analysis, setAnalysis] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (latest && !analysis) get(`/analyses/${latest.id}`).then((r) => setAnalysis(r.analysis), setErr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest?.id]);
  const a = analysis;
  const res = a?.result;
  const demoOrg = me?.organizations.some((o) => o.is_demo);
  return (
    <div className="grid2 analysis">
      <Card title="What the analysis uses">
        {preview.error && <ErrorBox error={preview.error} />}
        {preview.data && (
          <>
            <p className="small">{preview.data.provider.dataHandling}</p>
            <ul className="small">
              {preview.data.manifest.map((m: any, i: number) => <li key={i}>{m.item} <span className="muted">({fmtBytes(m.bytes)})</span></li>)}
            </ul>
            {preview.data.redactions.count > 0 && <p className="small">{preview.data.redactions.count} value(s) redacted ({preview.data.redactions.kinds.join(", ")}).</p>}
            {preview.data.provider.external && <div className="alert warn small">This project uses an external provider: the excerpts above are sent to {preview.data.provider.endpoint ?? "the provider"}. Whole repositories are never sent.</div>}
            <ActionButton kind="primary" disabled={!preview.data.provider.available} onClick={async () => { setErr(null); try { const r = await post(`/tasks/${taskId}/analyze`); setAnalysis(r.analysis); onAnalyzed(); } catch (e) { setErr(e); } }}>
              {a ? "Analyze again" : "Analyze this failure"}
            </ActionButton>
          </>
        )}
        <ErrorBox error={err} />
      </Card>
      <Card title={res ? <>Diagnosis <span className={`badge ${res.confidence === "high" ? "ok" : res.confidence === "medium" ? "warn" : "muted"}`}>{res.confidence} confidence</span></> : "Diagnosis"}>
        {!a && <Empty>No analysis yet.</Empty>}
        {a && a.status !== "succeeded" && <div className="alert bad">Analysis {a.status}: {a.error}</div>}
        {res && (
          <div className="diag">
            <p className="strong">{res.summary}</p>
            {res.insufficientEvidence && <div className="alert warn small">The evidence is not sufficient for a confident root cause; treat this as a starting point.</div>}
            <h3>Probable root cause</h3>
            <p>{res.rootCause}</p>
            <h3>Locations</h3>
            <ul>
              {res.locations.map((l: any, i: number) => (
                <li key={i}>
                  <SourceLink jobId={jobId} file={l.file} line={l.line} /> — {l.why}{" "}
                  {l.verified ? <span className="badge ok">exists in sources</span> : <span className="badge warn" title="the provider named a location that does not exist in the job's sources">unverified</span>}
                </li>
              ))}
            </ul>
            <h3>Evidence</h3>
            <ul className="evidence">
              {res.evidence.map((e: any, i: number) => (
                <li key={i}>
                  <span className="badge muted">{e.kind}</span> {e.file && <SourceLink jobId={jobId} file={e.file} line={e.line} />}
                  {e.kind === "waveform" ? <><pre className="code small">{e.text}</pre><button className="btn tiny" onClick={onWave}>Open waveform</button></> : <span className="mono small"> {e.text}</span>}
                </li>
              ))}
            </ul>
            {res.potentialFix && <><h3>Possible fix (not verified)</h3><p>{res.potentialFix}</p></>}
            {res.investigation?.length > 0 && <><h3>Next steps</h3><ol>{res.investigation.map((s: string, i: number) => <li key={i}>{s}</li>)}</ol></>}
            {res.notes?.length > 0 && <p className="small muted">{res.notes.join(" ")}</p>}
            <p className="small muted">Provider {a.provider}{a.model ? ` / ${a.model}` : ""}{a.tokens_in != null ? ` · ${a.tokens_in} tokens in, ${a.tokens_out} out` : ""}{a.latency_ms != null ? ` · ${fmtDuration(a.latency_ms)}` : ""}</p>
            <div className="actions">
              {a.provider !== "heuristic" && (
                <ActionButton onClick={async () => { await post(`/analyses/${a.id}/patch`); nav(`/runs/${jobId}`); }}>Suggest a patch (AI-generated, needs verification)</ActionButton>
              )}
              {demoOrg && (
                <ActionButton kind="primary" onClick={async () => { const p = await post(`/jobs/${jobId}/demo-patch`); const v = await post(`/patches/${p.patch.id}/verify`); nav(`/runs/${v.job.id}`); }}>
                  Demo: verify the reference fix in a fresh run
                </ActionButton>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function SourceLink({ jobId, file, line }: { jobId: string; file: string; line?: number }) {
  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  return (
    <span className="srclink">
      <button className="link mono" onClick={async () => { setOpen(!open); if (!src) { try { setSrc(await get(`/jobs/${jobId}/source/file?path=${encodeURIComponent(file)}${line ? `&from=${Math.max(1, line - 6)}&to=${line + 6}` : ""}`)); } catch (e) { setErr(e); } } }}>
        {file}{line ? `:${line}` : ""}
      </button>
      {open && (
        <span className="srcpop">
          <ErrorBox error={err} />
          {src && <pre className="code small">{src.lines.map((l: string, i: number) => <div key={i} className={src.from + i === line ? "hlline" : ""}><span className="ln">{src.from + i}</span>{l}</div>)}</pre>}
        </span>
      )}
    </span>
  );
}

function Artifacts({ artifacts }: { artifacts: any[] }) {
  if (!artifacts.length) return <Card><Empty>No artifacts.</Empty></Card>;
  return (
    <Card>
      <table className="table">
        <thead><tr><th>Kind</th><th>Name</th><th>Size</th><th>Expires</th><th /></tr></thead>
        <tbody>
          {artifacts.map((a) => (
            <tr key={a.id}>
              <td>{a.kind}</td><td className="mono small">{a.name}</td><td>{fmtBytes(a.size_bytes)}</td><td className="small">{a.expires_at ? new Date(a.expires_at).toLocaleDateString() : "kept"}</td>
              <td><a className="btn tiny" href={`/api/v1/artifacts/${a.id}/download`} download>Download</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Reproduce({ taskId }: { taskId: string }) {
  const r = useApi(`/tasks/${taskId}/reproduce`, [taskId]);
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <Loading />;
  const d = r.data;
  const script = [
    d.commit ? `git checkout ${d.commit}` : "# sources: the uploaded snapshot recorded for this run (download it from the run's artifacts)",
    `# toolchain: ${d.toolchain?.verilator ?? "?"}, image ${d.toolchain?.image ?? "?"} ${d.toolchain?.imageDigest ?? ""}`,
    d.buildCommand ? d.buildCommand : "# build command not recorded",
    d.runCommand ?? "",
  ].join("\n");
  return (
    <Card title="Reproduce locally">
      <p className="small">Same sources, configuration (sha256 <span className="mono">{String(d.configSha256).slice(0, 16)}…</span>), toolchain and seed. Re-running through the API uses the recorded source and configuration exactly.</p>
      <pre className="code">{script}</pre>
      <Copy text={script} />
      <p className="small mono">{d.rerunApi}</p>
    </Card>
  );
}
