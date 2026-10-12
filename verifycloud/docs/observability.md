# Observability

## Endpoints

| Endpoint | Meaning |
| --- | --- |
| `GET /health` | the process is up (liveness) |
| `GET /ready` | PostgreSQL and object storage reachable (readiness); 503 with `{checks}` otherwise |
| `GET /metrics` | Prometheus text format; requires `Authorization: Bearer $METRICS_TOKEN`, or comes from loopback when no token is set |

Failure injection confirmed `/ready` turns 503 with `objectStorage: false`
during a storage outage and `database: false` while PostgreSQL is stopped,
and returns to 200 afterwards.

## Metrics

| Metric | Type | Labels |
| --- | --- | --- |
| `api_requests_total` | counter | method, route, status |
| `api_request_latency_seconds` | histogram | route |
| `queue_depth` | gauge | — (queued tasks) |
| `jobs_total` | counter | trigger |
| `jobs_failed_total` | counter | state |
| `jobs_running` | gauge | — |
| `tasks_finished_total` | counter | kind, state |
| `worker_heartbeats_total` | counter | — |
| `workers_online` | gauge | — |
| `simulation_duration_seconds` | histogram | — |
| `build_duration_seconds` | histogram | — |
| `scheduling_latency_seconds` | histogram | — (queued → claimed) |
| `test_pass_rate` | gauge | — (last hour) |
| `coverage_percent` | gauge | project, metric (latest merged job) |
| `artifact_bytes_total` | counter | kind |
| `ai_analysis_latency_seconds` | histogram | provider |
| `ai_analysis_failures_total` | counter | provider, reason |
| `build_cache_lookups_total` | counter | result (hit/miss) |
| `lease_expirations_total` | counter | — |
| `stale_task_reports_total` | counter | — (fenced-off worker reports) |
| `webhook_deliveries_total` | counter | provider, result |
| `rate_limited_total` | counter | kind |
| `notifications_total` | counter | kind, result |
| `retention_objects_deleted_total` | counter | — |
| `process_resident_memory_bytes` | gauge | — |

Route labels use the route pattern (`/api/v1/jobs/:id`), never raw URLs, to
bound cardinality.

## Suggested alerts

| Alert | Expression (sketch) |
| --- | --- |
| No workers | `workers_online == 0 and queue_depth > 0` for 5 m |
| Queue growing | `deriv(queue_depth[15m]) > 0` and `scheduling_latency_seconds` p95 > 5 m |
| Lease churn | `rate(lease_expirations_total[10m]) > 0.1` (workers dying or overloaded) |
| Infra errors | `rate(tasks_finished_total{state="ERROR"}[10m]) > 0` |
| API errors | `rate(api_requests_total{status=~"5.."}[5m]) / rate(api_requests_total[5m]) > 1%` |
| Not ready | `/ready` failing |
| Notification backlog | `notifications_total{result="failed"}` increasing |

## Logs

* API: structured JSON (pino via Fastify) with request id, method, route,
  status, latency; `Authorization`, cookies and webhook signatures are
  redacted; errors carry the request id returned to the client.
* Worker: one JSON line per event (`worker registered`, `task finished`,
  `lease lost`, `registration failed; retrying`, …).
* Simulation logs are artifacts (first `MAX_LOG_BYTES`, with a truncation
  note), searchable through `/tasks/:id/log`.

## Tracing

Request ids propagate from the API to logs and error responses. There is no
distributed tracing (OpenTelemetry) yet.
