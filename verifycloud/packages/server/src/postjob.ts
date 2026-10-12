// Work done when a job reaches a terminal state: merged coverage, coverage
// comparison with the previous job on the same branch, notifications, and the
// GitHub check / status. Runs after the job's final transaction committed;
// failures here never change the job's recorded result.
import { gunzipSync, gzipSync } from "node:zlib";

import { coverageDelta, mergeCoverage, summarize, type CoverageDetail, type CoverageSummary } from "@verifycloud/shared";

import type { Ctx } from "./app.js";
import { storeArtifact } from "./artifacts.js";
import { tx } from "./db.js";
import { emit } from "./events.js";

const COVERAGE_DROP_THRESHOLD = 0.5; // percentage points

export async function mergeJobCoverage(ctx: Ctx, job: Record<string, any>): Promise<CoverageSummary | null> {
  const rows = (
    await ctx.db.query(
      `SELECT a.storage_key FROM coverage_runs cr JOIN artifacts a ON a.id = cr.detail_artifact_id
        WHERE cr.job_id = $1 AND cr.task_id IS NOT NULL`,
      [job.id],
    )
  ).rows;
  if (rows.length === 0) return null;
  const details: CoverageDetail[] = [];
  for (const r of rows) details.push(JSON.parse(gunzipSync(await ctx.store.getBuffer(r.storage_key, 64 * 1024 * 1024), { maxOutputLength: 512 * 1024 * 1024 }).toString("utf8")));
  const merged = mergeCoverage(details);
  const summary = summarize(merged);
  const art = await storeArtifact(ctx, {
    orgId: job.org_id,
    projectId: job.project_id,
    jobId: job.id,
    taskId: null,
    kind: "coverage",
    name: "coverage-merged.json.gz",
    contentType: "application/json",
    encoding: "gzip",
    body: gzipSync(JSON.stringify(merged)),
    metadata: { merged: true, tests: rows.length },
  });
  await tx(ctx.db, async (c) => {
    await c.query("DELETE FROM coverage_runs WHERE job_id = $1 AND task_id IS NULL", [job.id]);
    await c.query(
      `INSERT INTO coverage_runs (org_id, project_id, job_id, task_id, branch, commit_sha, regression, line_covered, line_total, branch_covered, branch_total,
                                  toggle_covered, toggle_total, functional_covered, functional_total, detail_artifact_id)
       VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [job.org_id, job.project_id, job.id, job.branch, job.commit_sha, job.regression, summary.line?.covered ?? null, summary.line?.total ?? null,
       summary.branch?.covered ?? null, summary.branch?.total ?? null, summary.toggle?.covered ?? null, summary.toggle?.total ?? null,
       summary.functional?.covered ?? null, summary.functional?.total ?? null, art.id],
    );
    await c.query("UPDATE jobs SET coverage = $2 WHERE id = $1", [job.id, JSON.stringify(summary)]);
    await emit(c, { type: "COVERAGE_UPDATED", orgId: job.org_id, projectId: job.project_id, jobId: job.id, data: { coverage: summary } });
  });
  for (const [k, m] of Object.entries(summary)) if (m && m.total) ctx.metrics.coverage.set((100 * m.covered) / m.total, { project: job.project_id, metric: k });
  return summary;
}

/** The most recent earlier finished job of the same project, regression and branch. */
export async function previousJob(ctx: Ctx, job: Record<string, any>) {
  const r = await ctx.db.query(
    `SELECT * FROM jobs WHERE project_id = $1 AND regression = $2 AND branch IS NOT DISTINCT FROM $3 AND id <> $4
        AND finished_at IS NOT NULL AND created_at < $5 AND trigger NOT IN ('patch')
      ORDER BY created_at DESC LIMIT 1`,
    [job.project_id, job.regression, job.branch, job.id, job.created_at],
  );
  return r.rows[0] ?? null;
}

export async function postJob(ctx: Ctx, jobId: string) {
  const job = (await ctx.db.query("SELECT j.*, p.name AS project_name, p.slug AS project_slug FROM jobs j JOIN projects p ON p.id = j.project_id WHERE j.id = $1", [jobId])).rows[0];
  if (!job) return;
  let coverage: CoverageSummary | null = null;
  try {
    coverage = await mergeJobCoverage(ctx, job);
  } catch (e) {
    ctx.log.warn({ err: (e as Error).message, jobId }, "coverage merge failed");
  }
  const prev = await previousJob(ctx, job);
  const delta = coverageDelta(prev?.coverage, coverage);
  const dropped = Object.entries(delta).filter(([, d]) => d && d.delta <= -COVERAGE_DROP_THRESHOLD);
  const failedTests = (
    await ctx.db.query("SELECT test_name, seed, state FROM tasks WHERE job_id = $1 AND kind = 'test' AND state NOT IN ('PASSED','SKIPPED','CANCELLED') ORDER BY ordinal LIMIT 50", [jobId])
  ).rows;
  const assertions = (await ctx.db.query("SELECT name, file, line, count(*)::int AS n FROM assertion_failures WHERE job_id = $1 GROUP BY name, file, line ORDER BY n DESC LIMIT 20", [jobId])).rows;
  const url = `${ctx.cfg.publicUrl}/projects/${job.project_id}/runs/${job.id}`;
  const s = job.summary ?? {};
  const headline = `${job.project_name} #${job.number} (${job.regression}): ${job.state} — ${s.passed ?? 0}/${s.tests ?? 0} tests passed`;
  const text = [
    headline,
    job.error ? `Error: ${job.error}` : "",
    failedTests.length ? `Failing: ${failedTests.map((t) => `${t.test_name} (seed ${t.seed}, ${t.state})`).join(", ")}` : "",
    assertions.length ? `Assertions: ${assertions.map((a) => `${a.name} at ${a.file}:${a.line} ×${a.n}`).join("; ")}` : "",
    Object.keys(delta).length ? `Coverage: ${Object.entries(delta).map(([k, d]) => `${k} ${d!.current}% (${d!.delta >= 0 ? "+" : ""}${d!.delta} pp)`).join(", ")}` : "",
    url,
  ].filter(Boolean).join("\n");

  await tx(ctx.db, async (c) => {
    // The outbox rows are enqueued at most once: the marker is set in the same
    // transaction (a re-run of postJob after a crash, via the sweep, sees it
    // and does nothing). Delivery of each outbox row is at-least-once (retries).
    const marker = (await c.query("SELECT post_processed_at FROM jobs WHERE id = $1 FOR NO KEY UPDATE", [jobId])).rows[0];
    if (marker?.post_processed_at) return;
    await c.query("UPDATE jobs SET post_processed_at = now() WHERE id = $1", [jobId]);
    if (job.trigger !== "demo") {
      const event = job.state === "SUCCEEDED" ? "regression_passed" : "regression_failed";
      await ctx.notifier.notifyProject(c, job.org_id, job.project_id, event, { subject: headline, text, jobId, state: job.state, url, failedTests, coverageDelta: delta });
      if (dropped.length)
        await ctx.notifier.notifyProject(c, job.org_id, job.project_id, "coverage_dropped", {
          subject: `${job.project_name}: coverage dropped`,
          text: `${dropped.map(([k, d]) => `${k}: ${d!.previous}% → ${d!.current}% (${d!.delta} pp)`).join("\n")}\n${url}`,
          jobId,
          url,
          coverageDelta: delta,
        });
      // infrastructure errors that exhausted their retries (not test failures)
      const infra = (await c.query("SELECT kind, test_name, seed, error FROM tasks WHERE job_id = $1 AND state = 'ERROR' ORDER BY ordinal LIMIT 20", [jobId])).rows;
      if (infra.length)
        await ctx.notifier.notifyProject(c, job.org_id, job.project_id, "worker_failure", {
          subject: `${job.project_name}: ${infra.length} run(s) failed for infrastructure reasons`,
          text: `${infra.map((t) => `${t.kind === "build" ? "build" : `${t.test_name} seed ${t.seed}`}: ${String(t.error ?? "").slice(0, 200)}`).join("\n")}\n${url}`,
          jobId,
          url,
        });
    }
    // GitHub: check run (preferred) + commit status
    const src = job.source ?? {};
    if (src.type === "github" && src.installationId && job.commit_sha && ctx.github.configured) {
      const conclusion = job.state === "SUCCEEDED" ? "success" : job.state === "CANCELLED" ? "cancelled" : job.state === "TIMED_OUT" ? "timed_out" : "failure";
      const md = [
        `**${job.state}** — ${s.passed ?? 0} of ${s.tests ?? 0} test runs passed${s.flaky ? ` (${s.flaky} flaky)` : ""}.`,
        job.error ? `\n> ${job.error}` : "",
        failedTests.length ? `\n### Failing tests\n${failedTests.map((t) => `- \`${t.test_name}\` seed ${t.seed} — ${t.state}`).join("\n")}` : "",
        assertions.length ? `\n### Assertion failures\n${assertions.map((a) => `- \`${a.name}\` at \`${a.file}:${a.line}\` (${a.n}×)`).join("\n")}` : "",
        Object.keys(delta).length
          ? `\n### Coverage vs. previous run on ${job.branch ?? "this branch"}\n| metric | previous | current | delta |\n|---|---|---|---|\n${Object.entries(delta).map(([k, d]) => `| ${k} | ${d!.previous}% | ${d!.current}% | ${d!.delta >= 0 ? "+" : ""}${d!.delta} pp |`).join("\n")}`
          : coverage
            ? `\n### Coverage\n${Object.entries(coverage).map(([k, m]) => `- ${k}: ${((100 * m!.covered) / m!.total).toFixed(1)}%`).join("\n")}`
            : "",
        `\n[Open the VerifyCloud report](${url})`,
      ].join("\n");
      await ctx.notifier.enqueue(c, job.org_id, "github_check", "job_completed", {
        jobId, installationId: src.installationId, repo: src.repository, sha: job.commit_sha,
        run: { status: "completed", conclusion, title: headline.slice(0, 200), summary: md, detailsUrl: url },
      });
      await ctx.notifier.enqueue(c, job.org_id, "github_status", "job_completed", {
        installationId: src.installationId, repo: src.repository, sha: job.commit_sha,
        state: job.state === "SUCCEEDED" ? "success" : "failure", description: headline, targetUrl: url,
      });
    }
  });
}
