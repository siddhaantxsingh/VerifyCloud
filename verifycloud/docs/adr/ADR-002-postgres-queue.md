# ADR-002: PostgreSQL is the system of record and the job queue

Status: accepted (2026-10-07)

## Context

Jobs, tasks, results, coverage and usage must be consistent with each other:
"task finished", "coverage recorded", "usage metered" and "job finalized"
should commit together or not at all. A separate broker (Redis, RabbitMQ)
would need a second consistency protocol (outbox, idempotent consumers) for
every state change.

## Decision

Tasks are rows. A worker claims one with a single transaction:

1. `pg_advisory_xact_lock(7471002)` — one claim decision at a time, so quota
   and fairness counts cannot be raced;
2. select the best `QUEUED` task the worker can fit (CPU/memory), ordered by
   the organization's running/quota ratio (fair share), then job age, using
   `FOR UPDATE SKIP LOCKED`;
3. set it `RUNNING` with a fresh random lease token and `lease_expires_at`.

Completion, retries, summaries, coverage, usage records and job finalization
happen in one transaction keyed by `(task id, lease token)`.

## Consequences

* Exactly one valid lease per task at any time; stale workers are fenced off
  (ADR-008). Measured: 0 duplicate executions across 1,616 tasks claimed by up
  to 25 concurrent workers (`docs/benchmarks/scheduler.json`).
* The global claim lock caps claim throughput. Measured on a 2-vCPU host:
  ~73 claims+completions per second in the original single runs (64–69 in the 2026-10 repeated runs), flat from 5 to 25 workers, with claim
  latency growing with worker count (p95 345 ms at 25 workers). That is ample
  for simulations lasting seconds to hours, but not for millions of
  sub-second tasks; see `docs/scaling.md` for the path beyond it
  (per-pool locks, batch claims).
* No extra infrastructure to operate or secure.
