# Testing

## Latest run (this environment, 2026-10-07)

`npx vitest run` — **81 tests in 7 files, all passed** (314 s), plus the
Playwright browser E2E (**2 tests passed**) run separately against a host
deployment and against the containerized deployment.

| Suite | File | Tests | Real dependencies |
| --- | --- | ---: | --- |
| Unit + property + fuzz | `packages/shared/test/units.test.ts` | 16 | none |
| API / DB / scheduler | `packages/server/test/scheduler.test.ts` | 16 | PostgreSQL, S3 emulator |
| Security | `packages/server/test/security.test.ts` | 16 | PostgreSQL, S3 emulator |
| Integrations (GitHub, AI, SSE, notifications, retention) | `packages/server/test/integrations.test.ts` | 14 | PostgreSQL, S3 emulator, fake GitHub API, LLM stub |
| Sandbox + adapter + demo E2E | `packages/worker/test/sandbox.test.ts` | 9 | Docker, Verilator image |
| Failure injection | `packages/worker/test/recovery.test.ts` | 3 | Docker, PostgreSQL restart, storage outage proxy |
| CLI + GitHub Action script | `packages/cli/test/cli.test.ts` | 7 | API server |
| Browser E2E | `packages/web/e2e/demo.spec.ts` | 2 | running deployment with worker |

Fakes are used only where the real service was unreachable: GitHub (a local
server that verifies the App JWT with the App's public key and records
calls), the LLM (an OpenAI-compatible stub), S3 (moto). Simulations,
containers and PostgreSQL are always real.

## Critical scenarios and where they are tested

| # | Scenario | Test |
| --- | --- | --- |
| 1 | One lease owns a task at a time and only that lease's result is recorded (execution itself is at-least-once: a partitioned worker may still run a stale attempt) | scheduler: "never hands one task to two workers…" + benchmark (0 of 1,616) |
| 2 | Stale worker reports after lease loss are rejected | scheduler: "rejects reports with a stale lease token" |
| 3 | Crashed worker → task re-queued, gives up after max attempts | scheduler: "recovers from a crashed worker…" |
| 4 | Infrastructure errors retried, test failures not | scheduler: "retries infrastructure errors…" |
| 5 | Job creation idempotent under concurrent requests | scheduler: "is idempotent per Idempotency-Key…" (8 concurrent) |
| 6 | Cancellation of queued and running work | scheduler: "cancels queued tasks immediately…" |
| 7 | Job deadline → `TIMED_OUT` | scheduler: "times out a job…" |
| 8 | Fair share and quotas | scheduler: "serves the organization using the smallest share…", "enforces the organization's concurrent task quota", "refuses regressions larger than the plan allows" |
| 9 | Flaky detection via retries | scheduler: "re-runs a failing test… marks it flaky" |
| 10 | Exact re-run | scheduler: "re-run creates a new job from the exact recorded source and configuration" |
| 11 | Cross-tenant isolation (404, no detection) | security: "user A cannot read, modify or even detect…", "an organization API key never reaches another organization" |
| 12 | RBAC and token scopes | security: "enforces viewer < engineer < admin < owner", "token scopes cap the owner's role…" |
| 13 | CSRF, credential handling, rate limits, error hygiene, injection | security suite |
| 14 | Malicious archives | security: "rejects malicious source archives…" |
| 15 | Public demo cannot run arbitrary code | security: "public demo mode…" |
| 16 | Hostile testbench contained | sandbox: network, DNS, read-only, caps, uid, socket, noexec, env |
| 17 | Resource exhaustion | sandbox: timeout, OOM, output flood, fork bomb, crash |
| 18 | Demo: FAIL → analysis → patch → verification → PASS | sandbox demo E2E (API) and `demo.spec.ts` (browser) |
| 19 | Recovery from API restart, storage outage, PostgreSQL restart | recovery suite |
| 20 | Tokens never leak to logs/notifications; webhooks signed; SSRF refused | integrations suite |

## Bugs found by these tests (and fixed)

* PostgreSQL restart crashed the API process (EventHub removed its error
  listener during reconnect) — recovery test.
* Synchronous Docker CLI calls blocked the worker's event loop during output
  floods, so leases expired and runs were retried three times — sandbox test.
* Exit code 137 from a self-inflicted SIGKILL was misreported as OOM —
  replaced by Docker's OOMKilled flag.
* Simulator ran as PID 1 and ignored signals; now `--init`.
* IPv6 literals (`https://[::1]`) passed webhook target validation — fixed.
* A fresh project showed no runnable regressions until a first job existed —
  fixed (catalog written on snapshot upload/seed).
* The scheduler benchmark initially measured nothing (its fake workers asked
  for less memory than the tasks required); the benchmark now fails unless
  every task completes.

## Not tested here (unverified)

Real GitHub, real LLM providers, real MinIO/AWS S3, `docker compose up` with
the official images, gVisor/rootless Docker, multi-host deployments, the CI
workflow on GitHub-hosted runners, load beyond one 2-vCPU host, browsers other
than Chromium, accessibility audit with assistive technology (only semantic
markup, labels, keyboard focus and ARIA roles were implemented).

## Running

```bash
npx vitest run                                    # everything (PostgreSQL, S3, Docker required)
VC_TEST_PG_RESTART=false npx vitest run           # without stopping the local PostgreSQL
E2E_BASE_URL=http://localhost:8080 E2E_PASSWORD=… npx playwright test -c packages/web/playwright.config.ts
```
