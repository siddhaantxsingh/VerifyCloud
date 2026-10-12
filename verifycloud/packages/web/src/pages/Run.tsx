import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { fmtBytes, fmtDuration, fmtPct, fmtTime, pct, post, TERMINAL, useApi, useEvents } from "../api";
import { ActionButton, Card, CovSummary, Crumbs, Empty, ErrorBox, Loading, Stat, State, Tabs } from "../components/ui";

export function RunPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const job = useApi(`/jobs/${id}`, [id]);
  const tasks = useApi(`/jobs/${id}/tasks`, [id]);
  const [tab, setTab] = useState("tests");
  const live = useEvents(id ? { job: id } : null, () => {
    void job.reload();
    void tasks.reload();
  });
  if (job.error) return <ErrorBox error={job.error} />;
  if (!job.data) return <Loading />;
  const j = job.data.job;
  const s = j.summary ?? {};
  const running = !TERMINAL.includes(j.state);
  const testRows = (tasks.data?.tasks ?? []).filter((t: any) => t.kind === "test");
  const build = (tasks.data?.tasks ?? []).find((t: any) => t.kind === "build");
  return (
    <div>
      <Crumbs items={[{ to: `/projects/${j.project_id}`, label: "Project" }, { label: `Run #${j.number}` }]} />
      <div className="pagehead">
        <div>
          <h1>Run #{j.number} <State s={j.state} /></h1>
          <p className="muted">
            regression <b>{j.regression}</b> · {j.trigger}{j.pr_number ? ` · PR #${j.pr_number}` : ""} · {j.commit_sha ? <span className="mono">{j.branch} @ {j.commit_sha.slice(0, 12)}</span> : j.branch} · created {fmtTime(j.created_at)}
            {running && <span className={`livedot ${live ? "on" : ""}`} title={live ? "live updates connected" : "reconnecting"}> live</span>}
          </p>
          {j.parent_job_id && <p className="small">Patch verification of <Link to={`/runs/${j.parent_job_id}`}>the original run</Link>. The patch was applied to a fresh copy of the sources; nothing was merged.</p>}
          {j.error && <div className="alert bad">{j.error}</div>}
        </div>
        <div className="actions">
          {running && <ActionButton kind="danger" confirm="Cancel this run? Running tests are stopped." onClick={async () => { await post(`/jobs/${id}/cancel`); await job.reload(); }}>Cancel</ActionButton>}
          {!running && <ActionButton onClick={async () => { const r = await post(`/jobs/${id}/rerun`); nav(`/runs/${r.job.id}`); }}>Re-run (same sources)</ActionButton>}
          {!running && s.failed > 0 && <ActionButton onClick={async () => { const failed = [...new Set(testRows.filter((t: any) => t.state !== "PASSED").map((t: any) => t.test_name))]; const r = await post(`/jobs/${id}/rerun`, { tests: failed }); nav(`/runs/${r.job.id}`); }}>Re-run failed tests</ActionButton>}
        </div>
      </div>
      <div className="stats">
        <Stat label="Tests" value={`${s.passed ?? 0} / ${s.tests ?? 0} passed`} sub={`${s.failed ?? 0} failed · ${s.running ?? 0} running · ${s.queued ?? 0} queued${s.flaky ? ` · ${s.flaky} flaky` : ""}`} />
        <Stat label="Build" value={build ? <State s={build.state} /> : "—"} sub={build?.summary ?? ""} />
        <Stat label="Wall time" value={j.started_at ? fmtDuration((j.finished_at ? Date.parse(j.finished_at) : Date.now()) - Date.parse(j.started_at)) : "—"} sub={`simulation ${s.testSeconds?.toFixed?.(1) ?? 0} s total`} />
        <Stat label="Line coverage" value={fmtPct(pct(j.coverage?.line))} sub={j.coverage?.branch ? `branch ${fmtPct(pct(j.coverage.branch))}` : "not measured"} />
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "tests", label: `Tests (${testRows.length})` },
          { id: "assertions", label: "Assertions" },
          { id: "coverage", label: "Coverage" },
          { id: "compare", label: "Compare" },
          { id: "patches", label: "Patches" },
          { id: "config", label: "Configuration & toolchain" },
        ]}
      />
      {tab === "tests" && <TestsTable rows={testRows} build={build} loading={tasks.loading && !tasks.data} />}
      {tab === "assertions" && <Assertions jobId={id!} />}
      {tab === "coverage" && <Coverage jobId={id!} />}
      {tab === "compare" && <Compare jobId={id!} />}
      {tab === "patches" && <Patches jobId={id!} />}
      {tab === "config" && <Config jobId={id!} />}
    </div>
  );
}

function TestsTable({ rows, build, loading }: { rows: any[]; build: any; loading: boolean }) {
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const shown = useMemo(
    () => rows.filter((t) => (filter === "all" || (filter === "failing" ? t.state !== "PASSED" && t.state !== "QUEUED" && t.state !== "RUNNING" && t.state !== "BLOCKED" : t.state === filter)) && (!q || t.test_name.includes(q))),
    [rows, filter, q],
  );
  return (
    <Card>
      {loading && <Loading />}
      {build && build.state !== "PASSED" && build.state !== "QUEUED" && build.state !== "RUNNING" && (
        <div className="alert bad">Build {build.state.toLowerCase()}: {build.summary} — <Link to={`/tasks/${build.id}`}>build log</Link></div>
      )}
      <div className="filters">
        <label>Show <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">all</option><option value="failing">failing</option><option value="PASSED">passed</option><option value="RUNNING">running</option><option value="QUEUED">queued</option>
        </select></label>
        <label>Test <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter by name" /></label>
      </div>
      {shown.length === 0 ? <Empty>No tests match.</Empty> : (
        <table className="table">
          <thead><tr><th>Test</th><th>Seed</th><th>State</th><th>Duration</th><th>Attempt</th><th>Result</th></tr></thead>
          <tbody>
            {shown.map((t) => (
              <tr key={t.id}>
                <td><Link to={`/tasks/${t.id}`} className="mono">{t.test_name}</Link></td>
                <td>{t.seed}</td>
                <td><State s={t.state} />{t.flaky && <span className="badge warn" title="failed, then passed on retry">flaky</span>}</td>
                <td>{fmtDuration(t.duration_ms)}</td>
                <td>{t.attempt}{t.failed_attempts ? ` (+${t.failed_attempts} retried)` : ""}</td>
                <td className="small">{t.error ?? t.summary ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {build && <p className="small muted">Build: <Link to={`/tasks/${build.id}`}>{build.state.toLowerCase()}</Link> in {fmtDuration(build.duration_ms)} — {build.summary}</p>}
    </Card>
  );
}

function Assertions({ jobId }: { jobId: string }) {
  const a = useApi(`/jobs/${jobId}/assertions`, [jobId]);
  const groups = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const x of a.data?.assertions ?? []) m.set(x.name, [...(m.get(x.name) ?? []), x]);
    return [...m.entries()];
  }, [a.data]);
  if (a.error) return <ErrorBox error={a.error} />;
  if (!a.data) return <Loading />;
  if (!groups.length) return <Card><Empty>No assertion failures recorded.</Empty></Card>;
  return (
    <Card>
      {groups.map(([name, rows]) => (
        <details key={name} open className="agroup">
          <summary><span className="mono strong">{name}</span> failed in {rows.length} run{rows.length > 1 ? "s" : ""} <span className="muted small">{rows[0].file}:{rows[0].line} — {rows[0].message}</span></summary>
          <table className="table small">
            <thead><tr><th>Test</th><th>Seed</th><th>Sim time</th><th>Scope</th><th /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.test_name}</td><td>{r.seed}</td><td>{r.sim_time}</td><td className="mono">{r.scope}</td>
                  <td><Link to={`/tasks/${r.task_id}?t=${r.sim_time}`}>{r.waveform_id ? "log & waveform" : "log"}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
    </Card>
  );
}

export function Coverage({ jobId }: { jobId: string }) {
  const c = useApi(`/jobs/${jobId}/coverage`, [jobId]);
  if (c.error) return <ErrorBox error={c.error} />;
  if (!c.data) return <Loading />;
  const d = c.data;
  if (!d.available) return <Card><Empty>No merged coverage for this run (coverage disabled, the run has not finished, or no test produced coverage).</Empty></Card>;
  const delta = Object.entries(d.delta ?? {}) as [string, { previous: number; current: number; delta: number }][];
  return (
    <div className="grid2">
      <Card title="Merged coverage">
        <CovSummary cov={d.summary} />
        <p className="small muted">Measured by {d.tool ?? "the simulator"}; merged across {d.perTest.length} test runs. Verilator line coverage counts statement blocks, not source lines.</p>
        {delta.length > 0 && (
          <p className="small">vs run <Link to={`/runs/${d.previous.jobId}`}>#{d.previous.number}</Link>: {delta.map(([k, v]) => <span key={k} className={v.delta < 0 ? "neg" : v.delta > 0 ? "pos" : ""}> {k} {v.delta > 0 ? "+" : ""}{v.delta.toFixed(1)} pp</span>)}</p>
        )}
      </Card>
      <Card title="Functional coverage (cover properties)">
        {d.functional?.length ? (
          <table className="table small">
            <thead><tr><th>Cover point</th><th>Location</th><th>Hits</th></tr></thead>
            <tbody>{d.functional.map((p: any) => <tr key={`${p.file}:${p.line}:${p.name}`} className={p.count === 0 ? "missrow" : ""}><td className="mono">{p.name}</td><td className="small">{p.file}:{p.line}</td><td>{p.count === 0 ? <b>0 (not hit)</b> : p.count}</td></tr>)}</tbody>
          </table>
        ) : <Empty>No cover properties.</Empty>}
      </Card>
      <Card title="Per file">
        <table className="table small">
          <thead><tr><th>File</th><th>Line</th><th>Branch</th><th>Toggle</th><th>Uncovered lines</th></tr></thead>
          <tbody>
            {d.files?.map((f: any) => (
              <tr key={f.file}>
                <td className="mono">{f.file}</td>
                <td>{fmtPct(pct(f.metrics.line))}</td><td>{fmtPct(pct(f.metrics.branch))}</td><td>{fmtPct(pct(f.metrics.toggle))}</td>
                <td className="small mono">{f.uncoveredLines.slice(0, 30).join(", ")}{f.uncoveredLines.length > 30 ? ` … (+${f.uncoveredLines.length - 30})` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Per test run">
        <table className="table small">
          <thead><tr><th>Test</th><th>Seed</th><th>Line</th><th>Branch</th><th>Toggle</th><th>Functional</th></tr></thead>
          <tbody>{d.perTest.map((t: any) => <tr key={t.taskId}><td><Link to={`/tasks/${t.taskId}`}>{t.test}</Link></td><td>{t.seed}</td><td>{fmtPct(pct(t.coverage.line))}</td><td>{fmtPct(pct(t.coverage.branch))}</td><td>{fmtPct(pct(t.coverage.toggle))}</td><td>{fmtPct(pct(t.coverage.functional))}</td></tr>)}</tbody>
        </table>
      </Card>
    </div>
  );
}

function Compare({ jobId }: { jobId: string }) {
  const c = useApi(`/jobs/${jobId}/compare`, [jobId]);
  if (c.error) return <Card><ErrorBox error={c.error} /></Card>;
  if (!c.data) return <Loading />;
  return <CompareView data={c.data} />;
}

export function CompareView({ data }: { data: any }) {
  const { base, head } = data;
  const row = (label: string, f: (s: any) => any) => <tr><th scope="row">{label}</th><td>{f(base)}</td><td>{f(head)}</td></tr>;
  const List = ({ title, items, cls }: { title: string; items: string[]; cls: string }) => (
    <div>
      <h3 className={cls}>{title} ({items.length})</h3>
      {items.length ? <ul className="mono small">{items.map((k) => <li key={k}>{k.replace("#", " seed ")}</li>)}</ul> : <p className="muted small">none</p>}
    </div>
  );
  return (
    <Card title={<>Comparing <Link to={`/runs/${base.job.id}`}>#{base.job.number}</Link> → <Link to={`/runs/${head.job.id}`}>#{head.job.number}</Link></>}>
      <table className="table compare">
        <thead><tr><th /><th>Base #{base.job.number}</th><th>Head #{head.job.number}</th></tr></thead>
        <tbody>
          {row("State", (s) => <State s={s.job.state} />)}
          {row("Source", (s) => <span className="mono small">{s.job.commit ? `${s.job.branch} @ ${s.job.commit.slice(0, 8)}` : s.job.branch}</span>)}
          {row("Passed", (s) => `${s.passed}/${s.tests}`)}
          {row("Assertion failures", (s) => s.assertionFailures)}
          {row("Simulation time", (s) => `${s.testSeconds.toFixed(1)} s`)}
          {row("Wall time", (s) => (s.wallSeconds === null ? "—" : `${s.wallSeconds.toFixed(1)} s`))}
          {(["line", "branch", "toggle", "functional"] as const).map((k) => row(`${k} coverage`, (s) => fmtPct(pct(s.coverage?.[k]))))}
          {row("Artifacts", (s) => fmtBytes(s.usage?.artifact_bytes))}
        </tbody>
      </table>
      <div className="grid3">
        <List title="Newly failing" items={data.newlyFailing} cls="neg" />
        <List title="Fixed" items={data.fixed} cls="pos" />
        <List title="Still failing" items={data.stillFailing} cls="" />
      </div>
      {(data.onlyInBase.length > 0 || data.onlyInHead.length > 0) && <p className="small muted">Only in base: {data.onlyInBase.join(", ") || "none"} · only in head: {data.onlyInHead.join(", ") || "none"}</p>}
    </Card>
  );
}

function Patches({ jobId }: { jobId: string }) {
  const p = useApi(`/jobs/${jobId}/patches`, [jobId]);
  const nav = useNavigate();
  const [diff, setDiff] = useState("");
  const [err, setErr] = useState<unknown>(null);
  return (
    <Card title="Patches">
      <p className="small">A patch is verified by running the regression again on a fresh copy of the sources with the patch applied, in isolated workers. Patches are never merged or pushed by VerifyCloud.</p>
      <ErrorBox error={p.error} />
      {p.data?.patches.length === 0 && <Empty>No patches for this run.</Empty>}
      {p.data?.patches.map((x: any) => (
        <div key={x.id} className="patch">
          <div className="patchhead">
            <span className={`badge ${x.origin === "ai" ? "warn" : "muted"}`}>{x.origin === "ai" ? "AI-generated — unverified until a verification run passes" : "submitted by a user"}</span>
            <span className="small muted">{x.files.join(", ")} · {fmtTime(x.created_at)}</span>
            <ActionButton kind="primary" onClick={async () => { const r = await post(`/patches/${x.id}/verify`); nav(`/runs/${r.job.id}`); }}>Verify in a fresh run</ActionButton>
          </div>
          <pre className="code diff">{x.diff.split("\n").map((l: string, i: number) => <span key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : ""}>{l + "\n"}</span>)}</pre>
          {x.verifications?.length > 0 && (
            <p className="small">Verification runs: {x.verifications.map((v: any) => <Link key={v.id} to={`/runs/${v.id}`} className="chip"> #{v.number} <State s={v.state} /></Link>)}</p>
          )}
        </div>
      ))}
      <details>
        <summary>Submit your own patch (unified diff)</summary>
        <textarea className="mono" rows={10} value={diff} onChange={(e) => setDiff(e.target.value)} placeholder={"--- a/rtl/file.sv\n+++ b/rtl/file.sv\n@@ -1,3 +1,3 @@"} spellCheck={false} />
        <ActionButton kind="secondary" onClick={async () => { setErr(null); try { await post(`/jobs/${jobId}/patches`, { diff }); setDiff(""); p.reload(); } catch (e) { setErr(e); } }}>Check & save patch</ActionButton>
        <ErrorBox error={err} />
      </details>
    </Card>
  );
}

function Config({ jobId }: { jobId: string }) {
  const c = useApi(`/jobs/${jobId}/config`, [jobId]);
  if (c.error) return <ErrorBox error={c.error} />;
  if (!c.data) return <Loading />;
  return (
    <div className="grid2">
      <Card title="Toolchain (recorded by the worker)">
        {c.data.toolchain ? (
          <dl className="kv">
            {Object.entries(c.data.toolchain).map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="mono small">{String(v)}</dd></div>)}
          </dl>
        ) : <Empty>Not recorded yet (build has not run).</Empty>}
      </Card>
      <Card title={<>Resolved configuration <span className="small muted mono">sha256 {String(c.data.sha256).slice(0, 16)}…</span></>}>
        <pre className="code small">{JSON.stringify(c.data.config, null, 2)}</pre>
      </Card>
    </div>
  );
}
