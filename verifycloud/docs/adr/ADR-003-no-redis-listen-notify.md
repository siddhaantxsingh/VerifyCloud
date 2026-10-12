# ADR-003: Real-time events via PostgreSQL LISTEN/NOTIFY and SSE (no Redis)

Status: accepted (2026-10-07)

## Context

The dashboard and the CLI need live job progress. Events must not be lost if
an API instance restarts, and every API replica must be able to serve any
client.

## Decision

* Every state change inserts a row into `job_events` (monotonic id) in the
  same transaction as the change and issues `NOTIFY vc_events`.
* Each API process holds one `LISTEN` connection (`EventHub`); on a
  notification it reads new rows by id and fans them out to Server-Sent
  Events subscribers, filtered by organization membership, project and job.
* Clients resume with `Last-Event-ID`; the hub replays from the table after a
  reconnect, so nothing committed is missed.

## Consequences

* No Redis/pub-sub to run. Failure injection verified: after a PostgreSQL
  restart the listener reconnects and a new job's `JOB_COMPLETED` arrives over
  SSE (`packages/worker/test/recovery.test.ts`). That test found and fixed a
  crash: the listener used to drop its error handler during reconnect.
* SSE is one-directional, which is all the UI needs; WebSockets were not
  necessary.
* `job_events` grows; retention deletes old rows with the job data.
