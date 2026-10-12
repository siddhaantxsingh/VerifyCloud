# Scaling

## What scales horizontally today

* **API**: stateless; run N replicas behind a load balancer. Each replica
  holds one LISTEN connection; SSE clients can connect to any replica.
  Migrations are guarded by an advisory lock.
* **Workers**: stateless; add hosts. Each worker advertises CPU/memory
  capacity and claims tasks that fit. Draining (SIGTERM) makes scale-in safe.
  Autoscale on `queue_depth` and `scheduling_latency_seconds`.
* **Object storage**: S3 scales independently.

## Known limits (measured or by design)

| Limit | Where | Measured / expected | Next step |
| --- | --- | --- | --- |
| Global claim lock | `pg_advisory_xact_lock(7471002)` in `claim` | ~64–69 claims/s on 2 vCPUs (2026-10 re-measurement; 73 in the original single runs), flat from 5 to 25 workers | per-pool or per-org-shard locks; claim several tasks per call; move fairness counts to a maintained table |
| Single PostgreSQL primary | all state | API reads ~800 rps per process on 2 vCPUs (shared with PG) | read replicas for dashboards/history, connection pooling (PgBouncer), partition `job_events`/`tasks` by time |
| Container start per run | Docker | ~0.2 s | keep tests ≥ seconds; batch seeds; pre-warmed sandboxes (with care: no reuse across tenants) |
| One worker host per Docker daemon | worker | CPU-bound | bigger hosts or more hosts |
| VCD size | waveform index in API memory (LRU) | bounded by `MAX_WAVEFORM_BYTES` | FST support, index in object storage with range reads |
| SSE fan-out | API memory | one subscriber per open tab | fine to thousands per replica; beyond that a dedicated gateway |

## Fairness and quotas

* Per plan: concurrent tasks and jobs per organization, maximum job duration,
  maximum runs per job, storage quota, AI tokens per month, retention caps.
* Per project: `max_concurrency`.
* Claim order: organizations using the smallest fraction of their
  concurrency quota first, then oldest job, then task order. One busy tenant
  cannot starve others (tested in scheduler tests).

## Multi-region / HA (not implemented)

A single region with a highly available PostgreSQL (managed, synchronous
standby) and S3 is the intended production shape. Cross-region active-active
would need a different queue design and is out of scope.
