# Architecture

VerifyCloud runs RTL verification (build, regression, coverage, failure
analysis) for many organizations on shared infrastructure without trusting
their code.

```mermaid
flowchart LR
  subgraph Clients
    B[Browser - React dashboard]
    C[verifycloud CLI]
    GA[GitHub Action]
    GH[GitHub App webhooks]
  end
  subgraph API["API process(es) - Fastify"]
    R[REST /api/v1 + OpenAPI]
    S[SSE /api/v1/events]
    I[Internal API /internal/v1]
    SCH[Scheduler: claim, lease, reaper]
    EH[EventHub LISTEN]
    AI[Failure analysis]
    OUT[Outboxes: GitHub checks, email, webhooks]
  end
  PG[(PostgreSQL: state, queue, events, usage)]
  S3[(S3 / MinIO: logs, models, coverage, waveforms, sources)]
  subgraph WH["Worker host (dedicated)"]
    W[Worker process]
    D[Docker daemon]
    SB1[[sandbox: verilator build]]
    SB2[[sandbox: test seed 1]]
    SB3[[sandbox: test seed N]]
  end
  B --> R
  B --> S
  C --> R
  GA --> C
  GH --> R
  R --> PG
  R --> S3
  SCH --> PG
  EH --> PG
  S --> EH
  OUT --> GHAPI[GitHub API]
  AI -. opt-in, redacted excerpts .-> LLM[LLM provider]
  W -->|worker token + lease| I
  W --> D
  D --> SB1
  D --> SB2
  D --> SB3
```

## Components

| Component | Responsibility | Code |
| --- | --- | --- |
| API | auth, tenancy/RBAC, projects, jobs, artifacts, coverage, compare, AI, webhooks, SSE, metrics | `packages/server` |
| Scheduler | job → tasks expansion, fair claim, leases, retries, cancellation, timeouts, finalization | `packages/server/src/scheduler.ts` |
| Worker | fetch sources, build once, run tests, collect logs/coverage/waveforms, enforce limits | `packages/worker` |
| Sandbox | one container per build/test run (ADR-004) | `packages/worker/src/sandbox.ts` |
| Simulator adapter | Verilator command lines, harness, output/coverage parsing | `packages/worker/src/adapters` |
| Shared | config schema, coverage, SV indexer, VCD, patches, tar | `packages/shared` |
| CLI | `verifycloud` | `packages/cli` |
| Web | dashboard | `packages/web` |

## Life of a regression

```mermaid
sequenceDiagram
  participant U as User / CLI / GitHub
  participant A as API
  participant P as PostgreSQL
  participant W as Worker
  participant X as Sandbox
  participant O as Object storage
  U->>A: POST /projects/:id/jobs {regression}
  A->>P: job + build task + N test tasks (BLOCKED), JOB_QUEUED event
  W->>A: POST /internal/v1/tasks/claim
  A->>P: advisory lock, pick fair task, lease token
  A-->>W: build task + lease
  W->>A: GET sources (snapshot or repo-scoped git credentials)
  W->>A: GET build cache (key = sources + config + toolchain)
  W->>X: verilator build (no network, limits)
  W->>A: upload model, complete(PASSED)
  A->>P: tests BLOCKED→QUEUED
  loop each test x seed (parallel across workers)
    W->>A: claim
    W->>X: run model +TEST +SEED (+coverage, +trace)
    W->>A: upload log, coverage, waveform (on failure), complete(state)
    A->>P: result, assertions, coverage, usage, TEST_COMPLETED event
  end
  A->>P: finalize job (SUCCEEDED / FAILED / TIMED_OUT / ...), JOB_COMPLETED
  A->>O: merged coverage
  A-->>U: SSE events, GitHub check, notifications
```

## States

Job: `QUEUED → RUNNING → SUCCEEDED | FAILED | CANCELLED | TIMED_OUT | RESOURCE_EXCEEDED | ERROR`.

Task: `BLOCKED` (waiting for the build) `→ QUEUED → RUNNING → PASSED | FAILED |
ERROR | TIMED_OUT | RESOURCE_EXCEEDED | CANCELLED | SKIPPED`.

Job finalization rule (in order): cancellation requested → `CANCELLED`; build
did not pass → the build's state (`FAILED`/`TIMED_OUT`/`RESOURCE_EXCEEDED`);
any test `FAILED`/`ERROR` → `FAILED`; any `TIMED_OUT` → `TIMED_OUT`; any
`RESOURCE_EXCEEDED` → `RESOURCE_EXCEEDED`; otherwise `SUCCEEDED`. A job past
its plan's maximum duration is finalized `TIMED_OUT` by the reaper.

## Trust boundaries

1. Internet → API: authenticated users/tokens; webhooks verified by HMAC.
2. API → worker: workers are semi-trusted infrastructure with a narrow API
   and no database/storage credentials.
3. Worker → sandbox: **untrusted**. Everything inside a sandbox is assumed
   hostile (ADR-004, docs/worker-security.md).
4. API → LLM provider: opt-in, minimal, redacted (ADR-007).

## Data

PostgreSQL holds all state (schema: docs/database.md). Object storage holds
blobs. Nothing durable lives on API or worker disks: both are stateless and
can be replaced at any time (workers drain on SIGTERM; leases cover crashes).

## What is not here

No Kubernetes manifests, no multi-region setup, no billing provider, no
commercial simulator adapters. See docs/scaling.md and the roadmap in the
README.
