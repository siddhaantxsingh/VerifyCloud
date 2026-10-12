# API

Base path: `/api/v1`. The OpenAPI 3 document is served at
`/api/v1/openapi.json` (a snapshot is committed as
[openapi.json](openapi.json)); it is generated from the same TypeBox schemas
that validate every request.

## Authentication

| Method | Header | Use |
| --- | --- | --- |
| Session cookie | `Cookie: vc_session=…` (set by `/auth/login`) | browser; writes also need an allowed `Origin` |
| Personal access token | `Authorization: Bearer vc_pat_…` | CLI, scripts; acts as the user, limited by scopes |
| Organization API key | `Authorization: Bearer vc_key_…` | CI; has its own role in one organization |

Scopes: `read` (GET), `write` (runs, patches, analyses), `admin`
(administrative routes). The effective permission is the role in the
organization intersected with the scopes.

## Errors

Every error has the same shape and an HTTP status that matches it:

```json
{ "error": { "code": "JOB_NOT_FOUND", "message": "job not found", "details": null, "requestId": "6f1c…" } }
```

| Status | Codes (examples) |
| --- | --- |
| 400 | `VALIDATION_FAILED`, `INVALID_PROJECT_CONFIG` (with `details.issues[]` and line numbers), `BAD_REQUEST` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN`, `DEMO_MODE_RESTRICTED` |
| 404 | `<RESOURCE>_NOT_FOUND`, `ROUTE_NOT_FOUND` — also for resources of other organizations |
| 409 | `NOT_RERUNNABLE`, `SOURCES_UNAVAILABLE`, `LEASE_LOST` (internal API) |
| 413 | `PAYLOAD_TOO_LARGE` |
| 429 | `RATE_LIMITED`, `QUOTA_EXCEEDED` (with `Retry-After` where applicable) |
| 503 | `SERVICE_UNAVAILABLE` (database or object storage unreachable; retry) |

`X-Request-Id` is returned on every response and logged server-side.

## Conventions

* IDs are UUIDs; organizations are addressed by slug.
* Lists are bounded (`limit` ≤ 200) and paginated with `before` cursors
  (`nextBefore` in the response).
* `POST /projects/:id/jobs` accepts `Idempotency-Key` (8–128 chars); repeated
  or concurrent requests with the same key return the same job (201 once,
  then 200).
* Times are ISO 8601 UTC.

## Main endpoints

```text
POST /auth/register | /auth/login | /auth/logout | /auth/verify-email | /auth/resend-verification
GET  /auth/github/start → /auth/github/callback          GitHub login (when configured)
GET  /me ; GET/POST /me/tokens ; DELETE /me/tokens/:id

GET/POST /orgs ; GET /orgs/:org ; GET /orgs/:org/dashboard | usage | audit
GET/POST /orgs/:org/members ; PATCH/DELETE /orgs/:org/members/:userId
GET/POST /orgs/:org/api-keys ; DELETE /orgs/:org/api-keys/:id
GET /orgs/:org/github/installations ; POST /orgs/:org/github/installations/claim

GET/POST /orgs/:org/projects ; GET/PATCH/DELETE /projects/:id
POST /projects/:id/config/validate | /projects/:id/detect
POST /projects/:id/snapshots (application/gzip tar) ; GET /projects/:id/snapshots
POST/DELETE /projects/:id/repository
GET /projects/:id/secrets ; PUT/DELETE /projects/:id/secrets/:name
GET/POST /projects/:id/notifications ; DELETE /projects/:id/notifications/:channel
GET /projects/:id/regressions | /projects/:id/tests/:name/history | /projects/:id/coverage | /projects/:id/compare?base=&head=
GET /projects/:id/artifacts

POST /projects/:id/jobs {regression?, tests?, snapshotId?, ref?} ; POST /jobs {projectId, …}
GET /projects/:id/jobs ; GET /jobs/:id | /jobs/:id/config | /jobs/:id/tasks | /jobs/:id/assertions | /jobs/:id/coverage | /jobs/:id/compare?with=
POST /jobs/:id/cancel | /jobs/:id/rerun {tests?}
GET /jobs/:id/source/index | /jobs/:id/source/file?path=&from=&to=
GET /tasks/:id | /tasks/:id/log?q=&severity=&offset=&limit= | /tasks/:id/reproduce

GET /artifacts/:id | /artifacts/:id/download (Range) ; DELETE /artifacts/:id
GET /artifacts/:id/waveform/signals?q= | /artifacts/:id/waveform/values?ids=&from=&to=&maxPoints=

GET /tasks/:id/analysis/preview ; POST /tasks/:id/analyze ; GET /analyses/:id
POST /analyses/:id/patch ; GET/POST /jobs/:id/patches ; POST /patches/:id/verify

GET /events?project=&job= (Server-Sent Events, Last-Event-ID)
POST /webhooks/github
GET /workers ; POST /auth/demo ; POST /jobs/:id/demo-patch
```

Outside `/api/v1`: `GET /health` (process up), `GET /ready` (database and
object storage reachable; 503 otherwise), `GET /metrics` (Prometheus text;
`METRICS_TOKEN` bearer or loopback).

## Events (SSE)

```text
event: TEST_COMPLETED
id: 1842
data: {"id":1842,"type":"TEST_COMPLETED","orgId":"…","projectId":"…","jobId":"…","data":{"taskId":"…","test":"random","seed":3,"state":"FAILED"},"at":"…"}
```

Types: `JOB_QUEUED`, `JOB_STARTED`, `TEST_STARTED`, `TEST_COMPLETED`,
`TEST_FAILED`, `COVERAGE_UPDATED`, `JOB_COMPLETED`. Reconnect with
`Last-Event-ID` (EventSource does this automatically) to receive events missed
while disconnected.

## Internal API (workers only)

`/internal/v1`: `workers/register` (registration secret), `workers/heartbeat`,
`tasks/claim`, `tasks/:id/heartbeat`, `tasks/:id/git-credentials`,
`tasks/:id/cache/:key`, `tasks/:id/artifacts/:artifactId` (download),
`tasks/:id/artifacts` (upload), `tasks/:id/complete`. All task routes require
`X-Lease-Token`. Not part of the public contract.

## Example: run a regression and wait

```bash
API=https://verifycloud.example.com/api/v1
H="Authorization: Bearer $VERIFYCLOUD_TOKEN"
SNAP=$(tar czf - -C my-ip . | curl -sf -H "$H" -H 'Content-Type: application/gzip' --data-binary @- $API/projects/$PROJECT/snapshots | jq -r .snapshot.id)
JOB=$(curl -sf -H "$H" -H 'Content-Type: application/json' -d "{\"regression\":\"smoke\",\"snapshotId\":\"$SNAP\"}" $API/projects/$PROJECT/jobs | jq -r .job.id)
curl -sN -H "$H" "$API/events?job=$JOB"     # or: verifycloud status $JOB --wait
```

(`tar` must produce regular files only; the CLI's snapshot is deterministic
and skips VCS metadata and build outputs.)
