// Job queue and scheduler (PostgreSQL-backed; see docs/adr/003-job-queue.md).
//
// Invariants:
//  * A task is executed by at most one worker at a time: claims happen in a
//    transaction holding a global advisory lock; every claim issues a new
//    lease token (fencing token), and every worker report must present the
//    current token. A report from a worker whose lease expired and was
//    re-claimed is rejected (and counted), so results are never applied twice.
//  * Results are never lost silently: a task whose worker disappears is
//    re-queued when its lease expires (bounded attempts), then marked ERROR.
//  * Historical results are immutable: a re-run creates a new job.
//  * Fairness: among organizations with eligible work, the one using the
//    smallest fraction of its concurrency quota is served first.
import { randomUUID } from "node:crypto";

import {
  expandRegression,
  TERMINAL_JOB_STATES,
  TERMINAL_TASK_STATES,
  type JobState,
  type JobTrigger,
  type ProjectConfig,
  type TaskState,
} from "@verifycloud/shared";
import type pg from "pg";

import type { ServerConfig } from "./config.js";
import { sha256hex } from "./crypto.js";
import { tx, type Db, type Q } from "./db.js";
import { E } from "./errors.js";
import { emit } from "./events.js";
import type { Metrics } from "./metrics.js";

/**
 * Bound worker-reported run times by what the server observed: 0 ≤ duration ≤
 * time since the lease was granted (database clock) + 1 s; CPU seconds ≤ that
 * time × the task's CPUs. Non-numbers fall back to the observed time / null.
 * Exported for unit tests.
 */
export function boundDurations(rep: { durationMs?: unknown; cpuSeconds?: unknown }, elapsedMs: number, cpus: number) {
  const observed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const maxMs = observed + 1000;
  const d = Number(rep.durationMs);
  const durationMs = Math.round(Number.isFinite(d) && typeof rep.durationMs === "number" ? Math.min(Math.max(d, 0), maxMs) : observed);
  let cpuSeconds: number | null = null;
  if (typeof rep.cpuSeconds === "number" && Number.isFinite(rep.cpuSeconds)) cpuSeconds = Math.min(Math.max(rep.cpuSeconds, 0), (maxMs / 1000) * Math.max(1, cpus || 1));
  return { durationMs, cpuSeconds };
}

export interface JobSource {
  type: "snapshot" | "github";
  snapshotId?: string;
  artifactId?: string; // source tarball (snapshot uploads; set by the build for GitHub sources)
  repository?: string;
  installationId?: number;
  sha?: string;
}

export interface CreateJobInput {
  orgId: string;
  projectId: string;
  regression: string;
  trigger: JobTrigger;
  source: JobSource;
  config: ProjectConfig;
  configText: string;
  commitSha?: string | null;
  branch?: string | null;
  prNumber?: number | null;
  requestedBy?: string | null;
  requestedToken?: string | null;
  idempotencyKey?: string | null;
  onlyTests?: string[] | null;
  parentJobId?: string | null;
  patchId?: string | null;
}

export interface TaskReport {
  state: Extract<TaskState, "PASSED" | "FAILED" | "ERROR" | "TIMED_OUT" | "RESOURCE_EXCEEDED" | "CANCELLED">;
  retryable?: boolean; // infrastructure error: may be retried on another worker
  exitCode?: number | null;
  durationMs: number;
  cpuSeconds?: number | null;
  error?: string | null;
  result?: Record<string, any>;
  // build only
  modelArtifactId?: string | null;
  sourceArtifactId?: string | null;
  cacheKey?: string | null;
  cacheHit?: boolean;
  toolchain?: Record<string, unknown> | null;
  // test only
  coverage?: { summary: Record<string, { covered: number; total: number }>; detailArtifactId?: string | null } | null;
  assertions?: { name: string; scope: string; severity: string; message: string; file: string; line: number; simTime: string | null }[];
}

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };

export class Scheduler {
  constructor(
    private db: Db,
    private cfg: ServerConfig,
    private metrics: Metrics,
    private log: Log,
    private hooks: { onJobFinished: (jobId: string) => Promise<void> } = { onJobFinished: async () => {} },
  ) {}

  // ------------------------------------------------------------ creation
  /** Create a job and its tasks. Idempotent per (org, idempotency key). */
  async createJob(input: CreateJobInput): Promise<{ job: Record<string, any>; created: boolean }> {
    if (input.idempotencyKey) {
      const ex = await this.db.query("SELECT * FROM jobs WHERE org_id = $1 AND idempotency_key = $2", [input.orgId, input.idempotencyKey]);
      if (ex.rows[0]) return { job: ex.rows[0], created: false };
    }
    const runs = expandRegression(input.config, input.regression, input.onlyTests ?? undefined);
    if (runs.length === 0) throw E.validation("the selected tests are not part of this regression");
    try {
      return await tx(this.db, async (c) => {
        const p = await c.query(
          "SELECT p.state, p.org_id, pl.max_test_runs_per_job, pl.max_job_seconds FROM projects p JOIN organizations o ON o.id = p.org_id JOIN plans pl ON pl.name = o.plan WHERE p.id = $1 FOR UPDATE OF p",
          [input.projectId],
        );
        const proj = p.rows[0];
        if (!proj) throw E.notFound("project");
        if (proj.state !== "active") throw E.conflict("PROJECT_NOT_ACTIVE", `project is ${proj.state}; jobs cannot be created`);
        if (runs.length > proj.max_test_runs_per_job)
          throw E.quota(`regression expands to ${runs.length} test runs; the plan allows ${proj.max_test_runs_per_job} per job`);
        const n = await c.query("SELECT coalesce(max(number), 0) + 1 AS n FROM jobs WHERE project_id = $1", [input.projectId]);
        const jobId = randomUUID();
        const cfgJson = JSON.stringify(input.config);
        const res = input.config.resources;
        const jr = await c.query(
          `INSERT INTO jobs (id, org_id, project_id, number, regression, state, trigger, requested_by, requested_token, idempotency_key,
                             source, commit_sha, branch, pr_number, config, config_sha256, only_tests, parent_job_id, patch_id, deadline_at, summary)
           VALUES ($1,$2,$3,$4,$5,'QUEUED',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now() + make_interval(secs => $19), $20)
           RETURNING *`,
          [
            jobId, input.orgId, input.projectId, n.rows[0].n, input.regression, input.trigger, input.requestedBy ?? null, input.requestedToken ?? null,
            input.idempotencyKey ?? null, JSON.stringify(input.source), input.commitSha ?? null, input.branch ?? null, input.prNumber ?? null, cfgJson,
            sha256hex(input.configText), input.onlyTests ?? null, input.parentJobId ?? null, input.patchId ?? null, proj.max_job_seconds,
            JSON.stringify({ tests: runs.length }),
          ],
        );
        const buildId = randomUUID();
        await c.query(
          `INSERT INTO tasks (id, job_id, org_id, project_id, kind, ordinal, state, cpu, memory_mb, timeout_seconds, queued_at)
           VALUES ($1,$2,$3,$4,'build',0,'QUEUED',$5,$6,$7, now())`,
          [buildId, jobId, input.orgId, input.projectId, res.cpu, res.compileMemoryMb ?? res.memoryMb, res.compileTimeoutSeconds],
        );
        // test tasks, inserted in chunks of 500 rows per statement
        const per = 13;
        for (let i = 0; i < runs.length; i += 500) {
          const chunk = runs.slice(i, i + 500);
          const params: unknown[] = [];
          const tuples = chunk.map((r, k) => {
            params.push(randomUUID(), jobId, input.orgId, input.projectId, i + k + 1, r.test, r.seed, JSON.stringify(r.plusargs), buildId, res.cpu, res.memoryMb, r.timeoutSeconds, r.retries);
            return `(${Array.from({ length: per }, (_, j) => `$${k * per + j + 1}`).join(",")})`;
          });
          await c.query(
            `INSERT INTO tasks (id, job_id, org_id, project_id, kind, ordinal, test_name, seed, plusargs, state, depends_on, cpu, memory_mb, timeout_seconds, test_retries)
             SELECT v.id::uuid, v.job_id::uuid, v.org_id::uuid, v.project_id::uuid, 'test', v.ordinal::int, v.test_name, v.seed::bigint, v.plusargs::jsonb, 'BLOCKED',
                    v.depends_on::uuid, v.cpu::int, v.mem::int, v.timeout::int, v.retries::int
               FROM (VALUES ${tuples.join(",")}) AS v(id, job_id, org_id, project_id, ordinal, test_name, seed, plusargs, depends_on, cpu, mem, timeout, retries)`,
            params,
          );
        }
        await upsertCatalog(c, input.projectId, input.config);
        await emit(c, { type: "JOB_QUEUED", orgId: input.orgId, projectId: input.projectId, jobId, data: { number: n.rows[0].n, regression: input.regression, tests: runs.length, trigger: input.trigger } });
        this.metrics.jobsTotal.inc({ trigger: input.trigger });
        return { job: jr.rows[0], created: true };
      });
    } catch (e) {
      // concurrent request with the same idempotency key
      if ((e as { code?: string }).code === "23505" && input.idempotencyKey) {
        const ex = await this.db.query("SELECT * FROM jobs WHERE org_id = $1 AND idempotency_key = $2", [input.orgId, input.idempotencyKey]);
        if (ex.rows[0]) return { job: ex.rows[0], created: false };
      }
      throw e;
    }
  }

  /** Record a job that could not start (e.g. invalid configuration from a webhook) so the failure is visible. */
  async createFailedJob(input: Omit<CreateJobInput, "config" | "configText" | "regression"> & { regression: string; error: string }) {
    return tx(this.db, async (c) => {
      const n = await c.query("SELECT coalesce(max(number), 0) + 1 AS n FROM jobs WHERE project_id = $1", [input.projectId]);
      const jobId = randomUUID();
      const r = await c.query(
        `INSERT INTO jobs (id, org_id, project_id, number, regression, state, trigger, source, commit_sha, branch, pr_number, config, config_sha256,
                           deadline_at, error, idempotency_key, finished_at, started_at)
         VALUES ($1,$2,$3,$4,$5,'FAILED',$6,$7,$8,$9,$10,'{}','', now(), $11, $12, now(), now()) RETURNING *`,
        [jobId, input.orgId, input.projectId, n.rows[0].n, input.regression, input.trigger, JSON.stringify(input.source), input.commitSha ?? null,
         input.branch ?? null, input.prNumber ?? null, input.error, input.idempotencyKey ?? null],
      );
      await emit(c, { type: "JOB_COMPLETED", orgId: input.orgId, projectId: input.projectId, jobId, data: { state: "FAILED", error: input.error } });
      return r.rows[0];
    });
  }

  // ------------------------------------------------------------ claiming
  /** Atomically claim the next eligible task for a worker with the given free capacity. */
  async claim(workerId: string, free: { cpu: number; memoryMb: number }): Promise<Record<string, any> | null> {
    return tx(this.db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7471002)");
      const r = await c.query(
        `WITH org_running AS (SELECT org_id, count(*)::int AS n FROM tasks WHERE state = 'RUNNING' GROUP BY org_id),
              proj_running AS (SELECT project_id, count(*)::int AS n FROM tasks WHERE state = 'RUNNING' GROUP BY project_id),
              org_jobs AS (SELECT org_id, count(*)::int AS n FROM jobs WHERE state = 'RUNNING' GROUP BY org_id)
         SELECT t.id
           FROM tasks t
           JOIN jobs j ON j.id = t.job_id
           JOIN projects p ON p.id = t.project_id
           JOIN organizations o ON o.id = t.org_id
           JOIN plans pl ON pl.name = o.plan
           LEFT JOIN org_running orr ON orr.org_id = t.org_id
           LEFT JOIN proj_running pr ON pr.project_id = t.project_id
           LEFT JOIN org_jobs oj ON oj.org_id = t.org_id
          WHERE t.state = 'QUEUED' AND NOT t.cancel_requested AND NOT j.cancel_requested
            AND j.state IN ('QUEUED', 'RUNNING')
            AND t.cpu <= $1 AND t.memory_mb <= $2
            AND coalesce(orr.n, 0) < pl.max_concurrent_tasks
            AND coalesce(pr.n, 0) < p.max_concurrency
            AND (j.state = 'RUNNING' OR coalesce(oj.n, 0) < pl.max_concurrent_jobs)
          ORDER BY coalesce(orr.n, 0)::float / pl.max_concurrent_tasks, j.created_at, t.ordinal
          LIMIT 1
          FOR UPDATE OF t SKIP LOCKED`,
        [free.cpu, free.memoryMb],
      );
      const id = r.rows[0]?.id;
      if (!id) return null;
      const t = (
        await c.query(
          `UPDATE tasks SET state = 'RUNNING', attempt = attempt + 1, lease_worker = $2, lease_token = $3,
                  lease_expires_at = now() + make_interval(secs => $4), started_at = now()
            WHERE id = $1 RETURNING *, extract(epoch FROM (now() - queued_at)) AS waited`,
          [id, workerId, randomUUID(), this.cfg.limits.leaseSeconds],
        )
      ).rows[0];
      this.metrics.schedulingLatency.observe(Number(t.waited));
      // Read the job without a row lock: completions hold it FOR NO KEY UPDATE, and
      // waiting for it here (inside the global claim lock) serialized every
      // claim behind every completion. Only the first claim flips QUEUED→RUNNING.
      // SKIP LOCKED: if cancel() or a completion holds the job row, leave the
      // flip to a later claim instead of waiting inside the global lock
      // (that wait could deadlock with cancel — audit M4).
      let j = (await c.query("SELECT * FROM jobs WHERE id = $1", [t.job_id])).rows[0];
      if (j.state === "QUEUED")
        j =
          (
            await c.query(
              "UPDATE jobs SET state = 'RUNNING', started_at = coalesce(started_at, now()) WHERE id = (SELECT id FROM jobs WHERE id = $1 AND state = 'QUEUED' FOR NO KEY UPDATE SKIP LOCKED) RETURNING *",
              [t.job_id],
            )
          ).rows[0] ?? j;
      if (t.kind === "build" && t.attempt === 1)
        await emit(c, { type: "JOB_STARTED", orgId: t.org_id, projectId: t.project_id, jobId: t.job_id, data: { number: j.number } });
      if (t.kind === "test")
        await emit(c, { type: "TEST_STARTED", orgId: t.org_id, projectId: t.project_id, jobId: t.job_id, data: { taskId: t.id, test: t.test_name, seed: Number(t.seed), attempt: t.attempt } });
      return { task: t, job: j };
    });
  }

  /** Validate a worker's lease. Returns the task row, or throws 409 for a stale lease. */
  private async checkLease(c: Q, taskId: string, workerId: string, leaseToken: string, lock = false) {
    const r = await c.query(
      `SELECT *, (extract(epoch FROM clock_timestamp() - started_at) * 1000)::float8 AS elapsed_ms FROM tasks WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
      [taskId],
    );
    const t = r.rows[0];
    if (!t) throw E.notFound("task");
    if (t.state !== "RUNNING" || t.lease_token !== leaseToken || t.lease_worker !== workerId) {
      this.metrics.staleReports.inc();
      throw E.conflict("LEASE_LOST", "the lease on this task is no longer held by this worker");
    }
    return t;
  }

  async heartbeat(taskId: string, workerId: string, leaseToken: string): Promise<{ cancel: boolean; leaseExpiresAt: string }> {
    const r = await this.db.query(
      `UPDATE tasks t SET lease_expires_at = now() + make_interval(secs => $4)
         FROM jobs j
        WHERE t.id = $1 AND t.lease_worker = $2 AND t.lease_token = $3 AND t.state = 'RUNNING' AND j.id = t.job_id
        RETURNING t.cancel_requested OR j.cancel_requested OR j.state NOT IN ('QUEUED','RUNNING') AS cancel, t.lease_expires_at`,
      [taskId, workerId, leaseToken, this.cfg.limits.leaseSeconds],
    );
    if (!r.rows[0]) {
      this.metrics.staleReports.inc();
      throw E.conflict("LEASE_LOST", "the lease on this task is no longer held by this worker");
    }
    return { cancel: r.rows[0].cancel, leaseExpiresAt: r.rows[0].lease_expires_at };
  }

  async checkLeaseExternal(taskId: string, workerId: string, leaseToken: string) {
    return this.checkLease(this.db, taskId, workerId, leaseToken);
  }

  // ------------------------------------------------------------ completion
  async complete(taskId: string, workerId: string, leaseToken: string, rep: TaskReport): Promise<{ state: TaskState; requeued: boolean; duplicate?: boolean }> {
    let finishedJob: string | null = null;
    const out = await tx(this.db, async (c) => {
      // Idempotent completion: a worker that retries after a lost response
      // (API restart, network blip) gets the recorded outcome, not an error.
      // The final UPDATE keeps lease_token, so only the lease holder matches.
      //
      // Lock order everywhere: job row first, then task rows (cancel, reaper
      // and claim follow the same order). Taking the task first deadlocked
      // against cancel() and the deadline reaper (audit 2026-10-08, H3).
      const ref = (await c.query("SELECT job_id FROM tasks WHERE id = $1", [taskId])).rows[0];
      if (!ref) throw E.notFound("task");
      const job = (await c.query("SELECT * FROM jobs WHERE id = $1 FOR NO KEY UPDATE", [ref.job_id])).rows[0];
      const prior = (await c.query("SELECT state, lease_token FROM tasks WHERE id = $1 FOR UPDATE", [taskId])).rows[0];
      if (prior && prior.lease_token === leaseToken && (TERMINAL_TASK_STATES as string[]).includes(prior.state))
        return { state: prior.state as TaskState, requeued: false, duplicate: true };
      const t = await this.checkLease(c, taskId, workerId, leaseToken, false);
      const base = { orgId: t.org_id, projectId: t.project_id, jobId: t.job_id };
      // Durations come from the worker's clock and are not trusted: a clock
      // step, a hostile worker or a missing field gave negative or NaN usage,
      // or overflowed tasks.duration_ms (500, result lost). Clamp them to the
      // time since the database granted this lease (audit 2026-10-14, L1).
      rep = { ...rep, ...boundDurations(rep, Number(t.elapsed_ms), t.cpu) };

      // usage of this attempt is recorded whatever happens next (also for
      // attempts that are retried; idempotent by source key — audit M7)
      const usage: [string, number][] = [["worker_seconds", rep.durationMs / 1000]];
      if (rep.cpuSeconds != null) usage.push(["cpu_seconds", rep.cpuSeconds]);
      if (t.kind === "test") usage.push(["simulation_seconds", rep.durationMs / 1000]);
      for (const [kind, qty] of usage)
        await c.query(
          "INSERT INTO usage_records (org_id, project_id, job_id, kind, quantity, source_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (source_key) DO NOTHING",
          [t.org_id, t.project_id, t.job_id, kind, qty, `task:${t.id}:${t.attempt}:${kind}`],
        );

      // A task may only go back to the queue while its job can still run it:
      // not after cancellation, not after the job was finalized (deadline),
      // not after the task itself was asked to stop (audit H2).
      const requeueAllowed = !job.cancel_requested && !t.cancel_requested && (job.state === "QUEUED" || job.state === "RUNNING");

      // infrastructure failure: retry elsewhere while attempts remain
      if (rep.state === "ERROR" && rep.retryable && t.attempt < t.max_attempts && requeueAllowed) {
        await c.query(
          "UPDATE tasks SET state = 'QUEUED', lease_worker = NULL, lease_token = NULL, lease_expires_at = NULL, queued_at = now(), error = $2 WHERE id = $1",
          [taskId, rep.error ?? "infrastructure error"],
        );
        return { state: "QUEUED" as TaskState, requeued: true };
      }
      // failing test with retries left: run again (flakiness detection), keep the evidence
      const attempts = t.test_attempts as unknown[];
      if (t.kind === "test" && rep.state === "FAILED" && attempts.length < t.test_retries && requeueAllowed) {
        // a flaky re-run is not an infrastructure retry: extend the attempt budget accordingly
        await c.query(
          `UPDATE tasks SET state = 'QUEUED', lease_worker = NULL, lease_token = NULL, lease_expires_at = NULL, queued_at = now(),
                  max_attempts = max_attempts + 1, test_attempts = test_attempts || $2::jsonb WHERE id = $1`,
          [taskId, JSON.stringify([{ state: rep.state, exitCode: rep.exitCode ?? null, durationMs: rep.durationMs, summary: rep.result?.summary ?? null, logArtifactId: rep.result?.logArtifactId ?? null, at: new Date().toISOString() }])],
        );
        return { state: "QUEUED" as TaskState, requeued: true };
      }
      const result = { ...(rep.result ?? {}), flaky: t.kind === "test" && rep.state === "PASSED" && attempts.length > 0 };
      await c.query(
        `UPDATE tasks SET state = $2, exit_code = $3, duration_ms = $4, result = $5, error = $6, finished_at = now(),
                lease_worker = NULL, lease_expires_at = NULL, model_artifact_id = coalesce($7, model_artifact_id)
          WHERE id = $1`,
        [taskId, rep.state, rep.exitCode ?? null, rep.durationMs, JSON.stringify(result), rep.error ?? null, rep.modelArtifactId ?? null],
      );
      this.metrics.tasksTotal.inc({ kind: t.kind, state: rep.state });

      if (t.kind === "build") {
        this.metrics.buildDuration.observe(rep.durationMs / 1000);
        if (rep.toolchain) await c.query("UPDATE jobs SET toolchain = $2 WHERE id = $1", [t.job_id, JSON.stringify(rep.toolchain)]);
        if (rep.sourceArtifactId)
          await c.query("UPDATE jobs SET source = source || jsonb_build_object('artifactId', $2::text) WHERE id = $1", [t.job_id, rep.sourceArtifactId]);
        if (rep.state === "PASSED") {
          if (rep.cacheKey && rep.modelArtifactId && !rep.cacheHit)
            await c.query(
              "INSERT INTO build_cache (org_id, cache_key, artifact_id, toolchain) VALUES ($1,$2,$3,$4) ON CONFLICT (org_id, cache_key) DO NOTHING",
              [t.org_id, rep.cacheKey, rep.modelArtifactId, JSON.stringify(rep.toolchain ?? {})],
            );
          if (!job.cancel_requested)
            await c.query("UPDATE tasks SET state = 'QUEUED', queued_at = now(), model_artifact_id = $2 WHERE depends_on = $1 AND state = 'BLOCKED'", [taskId, rep.modelArtifactId]);
        } else {
          await c.query("UPDATE tasks SET state = 'SKIPPED', finished_at = now() WHERE depends_on = $1 AND state IN ('BLOCKED','QUEUED')", [taskId]);
        }
      } else {
        this.metrics.simulationDuration.observe(rep.durationMs / 1000);
        for (const a of rep.assertions ?? [])
          await c.query(
            "INSERT INTO assertion_failures (org_id, job_id, task_id, name, scope, severity, message, file, line, sim_time) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
            [t.org_id, t.job_id, t.id, a.name.slice(0, 200), a.scope.slice(0, 500), a.severity, a.message.slice(0, 2000), a.file.slice(0, 500), a.line, a.simTime],
          );
        if (rep.coverage?.summary) {
          const s = rep.coverage.summary;
          await c.query(
            `INSERT INTO coverage_runs (org_id, project_id, job_id, task_id, branch, commit_sha, regression, test_name,
               line_covered, line_total, branch_covered, branch_total, toggle_covered, toggle_total, functional_covered, functional_total, detail_artifact_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [t.org_id, t.project_id, t.job_id, t.id, job.branch, job.commit_sha, job.regression, t.test_name,
             s.line?.covered ?? null, s.line?.total ?? null, s.branch?.covered ?? null, s.branch?.total ?? null,
             s.toggle?.covered ?? null, s.toggle?.total ?? null, s.functional?.covered ?? null, s.functional?.total ?? null, rep.coverage.detailArtifactId ?? null],
          );
        }
        await emit(c, {
          type: rep.state === "PASSED" ? "TEST_COMPLETED" : "TEST_FAILED",
          ...base,
          data: { taskId, test: t.test_name, seed: Number(t.seed), state: rep.state, durationMs: rep.durationMs, summary: rep.result?.summary ?? null, flaky: result.flaky },
        });
      }
      await this.refreshSummary(c, t.job_id);
      if (await this.maybeFinalize(c, t.job_id)) finishedJob = t.job_id;
      return { state: rep.state as TaskState, requeued: false };
    });
    if (finishedJob) await this.hooks.onJobFinished(finishedJob).catch((e) => this.log.error({ err: (e as Error).message, jobId: finishedJob }, "post-job hook failed"));
    return out;
  }

  private async refreshSummary(c: Q, jobId: string) {
    await c.query(
      `UPDATE jobs SET summary = (
         SELECT jsonb_build_object(
           'tests', count(*) FILTER (WHERE kind = 'test'),
           'passed', count(*) FILTER (WHERE kind = 'test' AND state = 'PASSED'),
           'failed', count(*) FILTER (WHERE kind = 'test' AND state IN ('FAILED','ERROR')),
           'timedOut', count(*) FILTER (WHERE kind = 'test' AND state = 'TIMED_OUT'),
           'resourceExceeded', count(*) FILTER (WHERE kind = 'test' AND state = 'RESOURCE_EXCEEDED'),
           'skipped', count(*) FILTER (WHERE kind = 'test' AND state IN ('SKIPPED','CANCELLED')),
           'running', count(*) FILTER (WHERE state = 'RUNNING'),
           'queued', count(*) FILTER (WHERE state IN ('QUEUED','BLOCKED')),
           'flaky', count(*) FILTER (WHERE kind = 'test' AND (result->>'flaky')::boolean),
           'build', max(state) FILTER (WHERE kind = 'build'),
           'testSeconds', coalesce(sum(duration_ms) FILTER (WHERE kind = 'test'), 0) / 1000.0,
           'buildSeconds', coalesce(sum(duration_ms) FILTER (WHERE kind = 'build'), 0) / 1000.0)
         FROM tasks WHERE job_id = $1)
       WHERE id = $1`,
      [jobId],
    );
  }

  /** If every task is terminal, set the job's final state. Returns true if it finalized now. */
  private async maybeFinalize(c: Q, jobId: string, forced?: JobState, error?: string): Promise<boolean> {
    const job = (await c.query("SELECT * FROM jobs WHERE id = $1", [jobId])).rows[0];
    if (!job || (TERMINAL_JOB_STATES as string[]).includes(job.state)) return false;
    const tasks = (await c.query("SELECT kind, state, error FROM tasks WHERE job_id = $1", [jobId])).rows as { kind: string; state: TaskState; error: string | null }[];
    if (!forced && !tasks.every((t) => (TERMINAL_TASK_STATES as string[]).includes(t.state))) return false;
    let state: JobState = forced ?? "SUCCEEDED";
    let err = error ?? null;
    if (!forced) {
      const build = tasks.find((t) => t.kind === "build");
      const tests = tasks.filter((t) => t.kind === "test");
      if (job.cancel_requested) state = "CANCELLED";
      else if (build && build.state !== "PASSED") {
        state = build.state === "TIMED_OUT" ? "TIMED_OUT" : build.state === "RESOURCE_EXCEEDED" ? "RESOURCE_EXCEEDED" : build.state === "CANCELLED" ? "CANCELLED" : "FAILED";
        err = `build ${build.state.toLowerCase()}${build.error ? `: ${build.error}` : ""}`;
      } else if (tests.some((t) => t.state === "FAILED" || t.state === "ERROR")) state = "FAILED";
      else if (tests.some((t) => t.state === "TIMED_OUT")) state = "TIMED_OUT";
      else if (tests.some((t) => t.state === "RESOURCE_EXCEEDED")) state = "RESOURCE_EXCEEDED";
      else if (tests.some((t) => t.state === "CANCELLED" || t.state === "SKIPPED")) state = "CANCELLED";
    }
    await c.query("UPDATE jobs SET state = $2, finished_at = now(), error = coalesce($3, error) WHERE id = $1", [jobId, state, err]);
    if (state !== "SUCCEEDED") this.metrics.jobsFailed.inc({ state });
    await emit(c, { type: "JOB_COMPLETED", orgId: job.org_id, projectId: job.project_id, jobId, data: { state, number: job.number, error: err } });
    return true;
  }

  // ------------------------------------------------------------ cancellation
  // Lock mode for job rows: FOR NO KEY UPDATE everywhere. It serializes the
  // scheduler's writers exactly like FOR UPDATE, but does not conflict with
  // the KEY SHARE lock that every foreign-key insert (job_events, usage
  // records, artifacts) takes on the referenced job. With FOR UPDATE, claim()
  // (task row locked, then a job_events insert) and cancel() (job row, then
  // task rows) deadlocked (audit H11).
  async cancel(jobId: string): Promise<Record<string, any>> {
    let finished = false;
    const job = await tx(this.db, async (c) => {
      const j = (await c.query("SELECT * FROM jobs WHERE id = $1 FOR NO KEY UPDATE", [jobId])).rows[0];
      if ((TERMINAL_JOB_STATES as string[]).includes(j.state)) return j;
      await c.query("UPDATE jobs SET cancel_requested = true WHERE id = $1", [jobId]);
      await c.query("UPDATE tasks SET state = 'CANCELLED', finished_at = now() WHERE job_id = $1 AND state IN ('QUEUED','BLOCKED')", [jobId]);
      await c.query("UPDATE tasks SET cancel_requested = true WHERE job_id = $1 AND state = 'RUNNING'", [jobId]);
      await this.refreshSummary(c, jobId);
      finished = await this.maybeFinalize(c, jobId);
      return (await c.query("SELECT * FROM jobs WHERE id = $1", [jobId])).rows[0];
    });
    if (finished) await this.hooks.onJobFinished(jobId).catch(() => {});
    return job;
  }

  // ------------------------------------------------------------ recovery
  /**
   * Periodic recovery:
   *  - tasks whose lease expired (worker crashed, partitioned, or killed) are
   *    re-queued, or marked ERROR after max_attempts;
   *  - jobs past their deadline are finalized as TIMED_OUT;
   *  - cancelled jobs whose running tasks' workers vanished are finalized.
   */
  async reap(): Promise<{ requeued: number; failed: number; timedOut: number }> {
    const finished: string[] = [];
    const res = await tx(this.db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7471002)");
      // job rows first, then their tasks (same lock order as complete/cancel)
      const jobIds = (await c.query("SELECT DISTINCT job_id FROM tasks WHERE state = 'RUNNING' AND lease_expires_at < now() ORDER BY job_id")).rows.map((r) => r.job_id);
      const expired: Record<string, any>[] = [];
      for (const jid of jobIds) {
        await c.query("SELECT 1 FROM jobs WHERE id = $1 FOR NO KEY UPDATE", [jid]);
        expired.push(
          ...(
            await c.query(
              "SELECT t.*, j.cancel_requested AS job_cancel, j.state AS job_state FROM tasks t JOIN jobs j ON j.id = t.job_id WHERE t.job_id = $1 AND t.state = 'RUNNING' AND t.lease_expires_at < now() FOR UPDATE OF t",
              [jid],
            )
          ).rows,
        );
      }
      let requeued = 0;
      let failed = 0;
      for (const t of expired) {
        this.metrics.leaseExpired.inc();
        if (t.attempt < t.max_attempts && !t.cancel_requested && !t.job_cancel && (t.job_state === "QUEUED" || t.job_state === "RUNNING")) {
          await c.query(
            "UPDATE tasks SET state = 'QUEUED', lease_worker = NULL, lease_token = NULL, lease_expires_at = NULL, queued_at = now(), error = 'worker lease expired; re-queued' WHERE id = $1",
            [t.id],
          );
          requeued++;
        } else {
          const st = t.cancel_requested || t.job_cancel ? "CANCELLED" : "ERROR";
          await c.query(
            "UPDATE tasks SET state = $2, finished_at = now(), lease_worker = NULL, lease_token = NULL, lease_expires_at = NULL, error = $3 WHERE id = $1",
            [t.id, st, st === "ERROR" ? `worker lost ${t.attempt} time(s); giving up` : "cancelled"],
          );
          if (t.kind === "build") await c.query("UPDATE tasks SET state = 'SKIPPED', finished_at = now() WHERE depends_on = $1 AND state IN ('BLOCKED','QUEUED')", [t.id]);
          failed++;
          await this.refreshSummary(c, t.job_id);
          if (await this.maybeFinalize(c, t.job_id)) finished.push(t.job_id);
        }
      }
      const late = (await c.query("SELECT id FROM jobs WHERE state IN ('QUEUED','RUNNING') AND deadline_at < now() FOR NO KEY UPDATE")).rows;
      for (const j of late) {
        await c.query("UPDATE tasks SET state = 'CANCELLED', finished_at = now() WHERE job_id = $1 AND state IN ('QUEUED','BLOCKED')", [j.id]);
        await c.query("UPDATE tasks SET cancel_requested = true WHERE job_id = $1 AND state = 'RUNNING'", [j.id]);
        await this.refreshSummary(c, j.id);
        if (await this.maybeFinalize(c, j.id, "TIMED_OUT", "job exceeded the maximum duration of its plan")) finished.push(j.id);
      }
      await c.query("UPDATE workers SET state = 'offline' WHERE state <> 'offline' AND last_heartbeat_at < now() - interval '2 minutes'");
      return { requeued, failed, timedOut: late.length };
    });
    for (const id of finished) await this.hooks.onJobFinished(id).catch(() => {});
    return res;
  }

  async queueDepth(): Promise<number> {
    const r = await this.db.query("SELECT count(*)::int AS n FROM tasks WHERE state = 'QUEUED'");
    return r.rows[0].n;
  }
}

export type { pg };

/** Regression/test catalog of a project (history pages, "Run" buttons), from a validated configuration. */
export async function upsertCatalog(c: Q, projectId: string, config: ProjectConfig) {
  for (const [name, r] of Object.entries(config.regressions))
    await c.query(
      "INSERT INTO regressions (project_id, name, tests, updated_at) VALUES ($1,$2,$3, now()) ON CONFLICT (project_id, name) DO UPDATE SET tests = EXCLUDED.tests, updated_at = now()",
      [projectId, name, r.tests],
    );
  await c.query("INSERT INTO test_cases (project_id, name) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING", [projectId, Object.keys(config.tests)]);
}
