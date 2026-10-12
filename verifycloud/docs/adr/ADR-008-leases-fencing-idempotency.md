# ADR-008: Leases with fencing tokens, at-least-once execution, idempotent completion

Status: accepted (2026-10-07)

## Context

Workers crash, lose network, or stall; the API restarts. A result must be
recorded once, a lost run must be re-run, and a slow "zombie" worker must not
overwrite a newer result.

## Decision

* A claim issues a random lease token. Heartbeats extend `lease_expires_at`;
  every heartbeat, upload and completion must present the current token.
* The reaper re-queues tasks whose lease expired (up to `max_attempts` = 3,
  then `ERROR`), and finalizes jobs past their deadline as `TIMED_OUT`.
* Completion is idempotent per lease token: a retry after a lost response gets
  the recorded outcome. Workers retry transient failures (connection errors,
  502/503/504) with backoff for up to a few minutes; dependency outages are
  reported by the API as 503.
* Infrastructure errors (`ERROR`, retryable) are re-queued; user errors
  (compile errors, failing tests, timeouts, resource limits) are not.

## Consequences

* Verified: an API restart, an object-storage outage and a PostgreSQL restart
  during a running simulation each end with the run recorded once on its first
  attempt (`recovery.test.ts`); lease expiry and stale-report rejection are
  covered by scheduler tests.
* Execution is at-least-once: after a lease expiry a test may run twice; only
  the current lease's result is kept. Simulations must not have external side
  effects (they cannot: no network).
