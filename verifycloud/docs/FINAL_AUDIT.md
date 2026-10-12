# Final engineering audit

> **Superseded (2026-10-10).** An independent audit on branch
> `audit/2026-10-08` found and fixed 2 Critical and 24 High defects that
> this document did not catch (sandbox output symlinks, API key privilege
> retention, scheduler deadlocks, an incomplete demo fix, and more). It also
> re-measured the performance claims below: they **did not reproduce** on the
> audit host. Use [audit-2026-10-08/](audit-2026-10-08/README.md) for the
> current status. This file is kept unchanged below as a historical record.

Date: 2026-10-07. Scope: the VerifyCloud repository at the commit containing
this file. Method: every requirement of the specification was checked against
the code and against tests that were actually executed in this environment.

Legend: **Done** = implemented and tested here · **Partial** = implemented
with gaps listed · **Unverified** = implemented but could not be executed
here · **Not done**.

## 1. Requirements

| Area | Status | Evidence / gaps |
| --- | --- | --- |
| Multi-tenancy, auth, sessions, PATs, org API keys | Done | security.test.ts (16 tests) |
| RBAC owner/admin/engineer/viewer + scopes | Done | security.test.ts |
| Email verification | Done | security.test.ts (outbox in tests; SMTP sending **Unverified**) |
| GitHub login (OAuth) | Unverified | implemented; no GitHub access |
| GitHub App: installations, push/PR jobs, check runs, statuses | Unverified (against real GitHub) | tested end to end against a fake GitHub API that verifies App JWTs; PR comments implemented in the outbox but not enabled |
| HDL project detection + proposed config | Done | units.test.ts, UI |
| `verifycloud.yaml` schema, line-numbered validation | Done | units.test.ts (incl. fuzz) |
| SimulatorAdapter + real Verilator backend | Done | sandbox.test.ts; Verilator 5.020 only |
| Isolated workers (container per run, no network, read-only, caps dropped, limits) | Done | sandbox.test.ts hostile-testbench cases |
| Queue states, leases, heartbeat, retries, cancellation, idempotency, fairness | Done | scheduler.test.ts (16), benchmark: 0 duplicates in 1,616 claims |
| Regression engine with seeds, parallel execution, quotas | Done | scheduler.test.ts, sandbox benchmark |
| Coverage: line/branch/toggle/functional, merge, per file/test, delta, history | Done | units + sandbox demo E2E + UI |
| Assertions (SVA) extraction | Done | adapter parsing on real logs, demo E2E |
| Waveforms: VCD capture, storage, index, browser viewer | Partial | VCD done; **FST not supported** |
| Logs: storage, truncation, search | Done | sandbox flood test, UI |
| Artifacts in S3-compatible storage | Done against moto; MinIO/AWS **Unverified** | integrations + recovery tests |
| PostgreSQL schema + migrations | Done | all server tests |
| AI assistant: context, redaction, providers, validation, patches, verification loop | Done (rule-based); LLM path **Unverified** with real providers | integrations.test.ts (stub LLM), demo E2E |
| Source intelligence (partial SV parser) | Done (documented as partial/heuristic) | units.test.ts |
| Regression comparison (runs, branches) | Done | UI + API; compare used in demo E2E |
| React + TS dashboard with live updates | Done | Playwright E2E; accessibility: semantic markup/labels/keyboard focus only, **no audit with assistive tech** |
| SSE real-time events with resume | Done | integrations.test.ts, recovery test (after PG restart) |
| Versioned API, OpenAPI, consistent errors | Done | docs/openapi.json (66 paths), security test on error shape |
| CLI | Done | cli.test.ts (7) |
| GitHub Action | Partial | script tested locally against a real API; **not run on GitHub** |
| Observability: /health, /ready, /metrics with the listed metrics, structured logs | Done | recovery tests check /ready; metrics names in docs/observability.md |
| Resource governance, usage ledger, notifications (email/GitHub/webhook), retention | Done | integrations.test.ts (webhook HMAC+retry, worker_failure, retention) |
| Security / threat model docs | Done | docs/security.md, docs/threat-model.md |
| Failure injection / recovery | Done | recovery.test.ts: API restart, storage outage, PostgreSQL restart |
| Load/performance at 1/5/10/25 workers with environment recorded | Done (single host) | docs/performance.md, docs/benchmarks/*.json |
| Cost engineering, reproducibility, build cache | Done | build cache 14.1 s → 0.02 s; re-run + reproduce |
| docker-compose, one-command dev, seeded demo, public demo mode | Partial | images built and run; compose with official images **Unverified**; public demo restrictions tested |
| CI workflow | Unverified | `.github/workflows/ci.yml` not executed |
| Documentation set + ADR-001..008 + README (GitHub Markdown, Mermaid) | Done | docs/ |

## 2. Correctness checks performed

* Full automated suite: 81/81 passed; browser E2E 2/2 passed against a host
  deployment and against the containerized API + worker.
* The demo numbers in README and docs were taken from these runs (8/12 failing
  on the buggy design; 12/12 passing with the fix; coverage 7/7, 19/22,
  236/282, 9/9).
* Benchmarks were re-run after a bug in the benchmark itself (fake workers
  asked for too little memory, so nothing was executed) was found; the script
  now refuses to report unless every task completed.

## 3. Security review summary

Strong: per-run sandbox with verified controls; workers without platform
credentials; lease fencing; hashed credentials; encrypted secrets; tenant
isolation by construction (404); CSRF origin checks; SSRF guard with
connect-time checks; strict archive and patch handling; public demo cannot
execute user-supplied code.

Residual risks: container escape on a worker host (mitigated by dedication;
gVisor optional, untested); results from a compromised worker are trusted for
its own tasks; no MFA/SSO; no WAF/DoS protection beyond rate limits; LLM
behavior with real models untested.

## 4. Bugs found during the final phase (all fixed, with tests)

1. API crash on PostgreSQL restart (EventHub listener).
2. Worker lease loss during output floods (blocking Docker CLI calls).
3. OOM misclassification of self-inflicted SIGKILL; simulator as PID 1.
4. IPv6 literal bypass of webhook target validation.
5. Empty regression list on fresh projects (UI could not start a first run).
6. Builds and tests shared one memory limit (compile needs more) →
   `compile_memory_mb`.
7. `docker-compose.yml` and CI built the simulator image with the wrong
   context (the Dockerfile copies the harness from the repository root).
8. Fork-bomb test relied on dash vs bash fork error wording; leftover-container
   check matched unrelated containers.

## 5. Production-readiness verdict

Not claimed. The system is **production-oriented**: stateless services,
migrations, health/readiness, metrics, graceful draining, recovery from
dependency outages, strict configuration guard in production mode, documented
deployment. Before a real production launch the following are required:
running the stack with real MinIO/S3 and real GitHub, executing the CI
workflow, a security review/penetration test of the sandbox host setup
(ideally with gVisor), load testing on multi-host hardware, backups and
restore drills, and an on-call runbook built from docs/observability.md.
