import { Link, useParams } from "react-router-dom";

import { fmtBytes, fmtPct, fmtTime, pct, useApi } from "../api";
import { RequireRole } from "../App";
import { Card, CovBar, Empty, ErrorBox, Loading, Stat, State } from "../components/ui";

export function Dashboard() {
  const { org } = useParams();
  const dash = useApi(`/orgs/${org}/dashboard`, [org]);
  const projects = useApi(`/orgs/${org}/projects`, [org]);
  const d = dash.data;
  const rate = d && d.tests7d.total > 0 ? (100 * d.tests7d.passed) / d.tests7d.total : null;
  return (
    <div>
      <div className="pagehead">
        <h1>Dashboard</h1>
        <RequireRole roles={["owner", "admin"]}>
          <Link className="btn primary" to={`/o/${org}/new-project`}>New project</Link>
        </RequireRole>
      </div>
      <ErrorBox error={dash.error ?? projects.error} />
      {d && (
        <div className="stats">
          <Stat label="Test pass rate (7 days)" value={fmtPct(rate)} sub={`${d.tests7d.passed} passed / ${d.tests7d.total} runs`} />
          <Stat label="Queue" value={`${d.queue.queued} queued`} sub={`${d.queue.running} running`} />
          <Stat label="Workers online" value={`${d.workers.online} / ${d.workers.total}`} sub="heartbeat within 1 min" />
          <Stat label="Simulation time (7 days)" value={`${(d.usage7d.simulation_seconds ?? 0).toFixed(0)} s`} sub={`worker ${(d.usage7d.worker_seconds ?? 0).toFixed(0)} s · artifacts ${fmtBytes(d.usage7d.artifact_bytes)}`} />
        </div>
      )}
      <div className="grid2">
        <Card title="Projects">
          {projects.loading && !projects.data ? <Loading /> : null}
          {projects.data?.projects.length === 0 && (
            <Empty>
              No projects yet. <RequireRole roles={["owner", "admin"]}><Link to={`/o/${org}/new-project`}>Create one</Link></RequireRole>
            </Empty>
          )}
          <ul className="list">
            {projects.data?.projects.map((p: any) => (
              <li key={p.id} className="listrow">
                <div>
                  <Link to={`/projects/${p.id}`} className="strong">{p.name}</Link>
                  <div className="small muted">{p.repository ? p.repository.full_name ?? p.repository : "snapshot uploads"} · last run {fmtTime(p.last_job_at)}</div>
                </div>
                <div className="right">
                  <State s={p.last_job_state} />
                  {p.last_job_summary && <div className="small muted">{p.last_job_summary.passed}/{p.last_job_summary.tests} passed</div>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Latest coverage per project">
          {d?.coverage.length === 0 && <Empty>No coverage yet.</Empty>}
          {d?.coverage.map((c: any) => (
            <div key={c.projectId} className="covblock">
              <Link to={`/projects/${c.projectId}`} className="strong">{c.project}</Link> <span className="small muted">{fmtTime(c.at)}</span>
              {(["line", "branch", "toggle", "functional"] as const).filter((k) => c.coverage[k]).map((k) => <CovBar key={k} label={k} c={c.coverage[k]} />)}
            </div>
          ))}
        </Card>
      </div>
      <Card title="Recent runs">
        {d?.recentJobs.length === 0 && <Empty>No runs yet.</Empty>}
        {d && d.recentJobs.length > 0 && (
          <table className="table">
            <thead>
              <tr><th>Run</th><th>Project</th><th>Regression</th><th>Source</th><th>State</th><th>Tests</th><th>Line cov.</th><th>Started</th></tr>
            </thead>
            <tbody>
              {d.recentJobs.map((j: any) => (
                <tr key={j.id}>
                  <td><Link to={`/runs/${j.id}`}>#{j.number}</Link></td>
                  <td>{j.project_name}</td>
                  <td>{j.regression}</td>
                  <td className="mono small">{j.commit_sha ? `${j.branch} @ ${j.commit_sha.slice(0, 8)}` : j.branch} <span className="muted">({j.trigger})</span></td>
                  <td><State s={j.state} /></td>
                  <td>{j.summary ? `${j.summary.passed ?? 0}/${j.summary.tests ?? 0}` : "—"}</td>
                  <td>{fmtPct(pct(j.coverage?.line))}</td>
                  <td>{fmtTime(j.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
