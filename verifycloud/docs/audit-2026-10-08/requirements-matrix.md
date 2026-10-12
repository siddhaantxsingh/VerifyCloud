# G. Requirements matrix

Statuses, used exactly as defined in the audit brief:

- **VERIFIED**: exercised by an automated test or a measured run on the final code in this audit, and it passed.
- **IMPLEMENTED BUT UNVERIFIED**: the code exists, but no check in this environment could exercise it end to end.
- **PARTIALLY IMPLEMENTED**: part of the requirement exists.
- **FAILED**: exercised, and it did not meet the requirement.
- **BLOCKED**: could not be attempted for lack of credentials, network or hardware.
- **NOT IMPLEMENTED**: absent.

| # | Requirement | Status | Evidence / gap |
| --- | --- | --- | --- |
| 1 | Multi-tenancy, sessions, PATs, org API keys | VERIFIED | security.test.ts, audit-security.test.ts (S1, S2, S5 fixed) |
| 2 | RBAC owner/admin/engineer/viewer + token scopes | VERIFIED | security.test.ts; audit-security S2 |
| 3 | Email verification (tokens, enforcement, outbox) | VERIFIED | security.test.ts |
| 3b | Email delivery over SMTP | IMPLEMENTED BUT UNVERIFIED | no SMTP server |
| 4 | GitHub OAuth login | IMPLEMENTED BUT UNVERIFIED | CSRF binding verified against a fake OAuth server (S8); real GitHub BLOCKED |
| 5 | GitHub App against real GitHub: installations, push/PR jobs, checks, statuses, redelivery | IMPLEMENTED BUT UNVERIFIED | integrations.test.ts against a fake GitHub that verifies App JWTs + HMAC; G1/S11 fixed and verified there |
| 6 | HDL project detection + proposed config | VERIFIED | units.test.ts |
| 7 | `verifycloud.yaml` schema with line-numbered errors | VERIFIED | units.test.ts (incl. fuzz), cli validate |
| 8 | Simulator adapter, real Verilator 5.020 backend | VERIFIED | sandbox.test.ts, bug-injection campaign; Verilator 5.020 only |
| 9 | Other simulators (commercial / Icarus) | NOT IMPLEMENTED | adapter interface only |
| 10 | UVM | NOT IMPLEMENTED | no UVM-capable simulator here; no UVM tests. Not claimed |
| 11 | Sandbox isolation with Docker/runc (no network, read-only, caps dropped, non-root, limits) | VERIFIED | sandbox.test.ts hostile cases, C1/C2/H5 tests. Not a perfect boundary (security report §1) |
| 12 | gVisor/VM isolation option | IMPLEMENTED BUT UNVERIFIED | runtime setting exists; runsc not available |
| 13 | Queue: leases, heartbeat, retries, cancellation, idempotent completion | VERIFIED | scheduler.test.ts, audit-scheduler.test.ts (12), chaos test |
| 14 | Result recording at most once per task (one lease's result) | VERIFIED | audit-scheduler M5/M6/chaos; benchmark: 0 tasks claimed twice |
| 15 | Exactly-once physical execution | NOT IMPLEMENTED | execution is at-least-once (ADR-008); documented, not claimed |
| 16 | Regression engine: seeds, parallel runs, quotas, fairness | VERIFIED | scheduler tests; sandbox benchmark |
| 17 | Coverage line/branch/toggle/functional, merge, deltas | VERIFIED | demo E2E (merged coverage), units |
| 18 | SVA assertion extraction | VERIFIED | adapter on real logs; campaign |
| 19 | Waveforms: VCD capture, index, viewer | VERIFIED | sandbox demo E2E |
| 19b | FST waveforms | NOT IMPLEMENTED | — |
| 20 | Logs: storage, truncation with tail, search | VERIFIED | flood test, M7w unit, recovery log search |
| 21 | Artifacts in S3-compatible storage (integrity, Range, interruption, limits), against moto | VERIFIED | audit-storage.test.ts, recovery outage test |
| 21b | Same, against MinIO / AWS S3 | BLOCKED | images and AWS unreachable; no credentials |
| 22 | PostgreSQL schema + migrations (001, 002) | VERIFIED | every server test; compose backup/restore shows both migrations |
| 23 | AI analysis: rule-based | VERIFIED | integrations, demo E2E, labeled evaluation (0 wrong of 28; 3 correct, 25 abstained) |
| 24 | AI analysis: LLM providers | IMPLEMENTED BUT UNVERIFIED | stub-LLM tests only (protocol, timeouts, invalid output, injection hardening); no API key |
| 25 | AI patch generation + verification in a new job | PARTIALLY IMPLEMENTED | user patches verified end to end; AI patch path tested against a stub; scope limits P2 verified |
| 26 | Prompt-injection and redaction controls | VERIFIED | P1/P2 tests, redaction corpus; model compliance not verifiable |
| 27 | Source intelligence (partial SV parser, documented as partial) | VERIFIED | units |
| 28 | Run/branch comparison | VERIFIED | API + demo E2E |
| 29 | Web dashboard with live updates | VERIFIED | Playwright E2E 2/2 (host and Compose) |
| 30 | SSE with resume, no gaps or duplicates | VERIFIED | integrations, M8s test, recovery after PG restart |
| 31 | Versioned API, OpenAPI, consistent errors | VERIFIED | security test on error shape; openapi.json |
| 32 | CLI | VERIFIED | cli.test.ts (7) |
| 33 | GitHub Action | IMPLEMENTED BUT UNVERIFIED | script exercised locally; never run on GitHub |
| 34 | Observability: /health, /ready, /metrics, structured logs | VERIFIED | recovery tests (/ready on outages); S4 |
| 35 | Usage ledger, notifications, retention | VERIFIED | integrations (webhooks HMAC + retry, worker_failure, retention deletes) |
| 36 | Failure injection: API restart, storage outage, PG restart, worker partition | VERIFIED | recovery.test.ts (4 incl. H1) |
| 37 | Performance at 1/5/10/25 workers with environment recorded | VERIFIED | benchmark-report.md. The original throughput claims did **not** reproduce; see there |
| 38 | Build cache | VERIFIED | sandbox test + costs benchmark |
| 39 | `cp .env.example .env; docker compose up --build` with official images | BLOCKED | registries unreachable (deployment-report.md) |
| 39b | Same Compose file with locally built stand-ins for the 3 unreachable images | VERIFIED | all healthy; browser E2E 2/2 |
| 40 | PostgreSQL backup/restore procedure (run once) | VERIFIED | compose-backup.log |
| 41 | CI workflow | IMPLEMENTED BUT UNVERIFIED | not executed (no GitHub Actions) |
| 42 | Lint/format gate | PARTIALLY IMPLEMENTED | `tsc --noEmit` only; no ESLint/Prettier |
| 43 | Documentation, ADRs (updated in this audit) | VERIFIED | docs/, this directory |
| 44 | Accessibility audit | NOT IMPLEMENTED | semantic markup only; no assistive-technology audit |
| 45 | Public demo mode restrictions | VERIFIED | security.test.ts |
| 46 | Demo design bug → diagnosis → verified fix | VERIFIED | demo E2E; fixed reference patch (R1) |
