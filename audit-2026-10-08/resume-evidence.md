# I. Resume evidence (verified only)

Each statement below is backed by a test or a measurement executed in this
audit; the evidence column says where. Nothing here refers to users,
customers, production traffic or external deployments. None exist.

| Statement | Evidence |
| --- | --- |
| Built a multi-tenant SaaS for RTL verification CI: TypeScript/Node API, PostgreSQL job queue with leases and fencing tokens, Docker-sandboxed Verilator workers, React dashboard with live SSE updates, CLI. | repository; 11+ test files; browser E2E |
| Designed the queue's delivery guarantees explicitly: at-most-once result recording per task (idempotent per lease token), one owning lease at a time, at-least-once execution with bounded retries. Exercised them with adversarial and randomized chaos tests. | audit-scheduler.test.ts (12 tests incl. chaos invariants) |
| Found and fixed scheduler concurrency defects: two deadlocks (lock-order inversion; `FOR UPDATE` vs foreign-key `KEY SHARE`), requeue into finished jobs, non-atomic upload fencing, lost late-committed events. Each was reproduced by a failing test first. | engineering-audit.md H3, H11, H2, M6, M8, M8b |
| Found by benchmarking that one of my own fixes cost 25% throughput at 1 worker (12–17% at 5–25 workers) and could stall event delivery. Diagnosed it with an interleaved A/B against the baseline and replaced it with sequence-gap tracking (back within noise of the baseline). | benchmark-report.md §2 |
| Hardened a container sandbox for untrusted HDL code: blocked host-file exfiltration via planted symlinks and worker hangs via FIFOs, flag deny-list canonicalisation, orphaned-container cleanup. | sandbox.test.ts AUDIT C1/C2/H5 (real Docker); worker/audit-units.test.ts (flag deny-list, H8) |
| Closed tenant-security gaps: API keys outliving their creator's role, OAuth login CSRF, GitHub installation takeover via login rename, proxy-header rate-limit bypass, an SSRF filter bug that blocked all IPv4. | audit-security.test.ts (12 tests) |
| Hardened LLM-assisted debugging against prompt injection (nonce-tagged, defanged evidence blocks; AI patches cannot touch the failing checker or config) and broadened secret redaction. | audit-ai.test.ts, integrations AUDIT P1/P2, audit-redact.test.ts |
| Evaluated the rule-based failure analyzer on a labeled bug-injection set (11 seeded defects plus a syntax error, real Verilator runs): 0 wrong diagnoses in 28 analyses; 3 correct; 25 abstained. | docs/benchmarks/ai-eval.json |
| Found an incomplete reference fix in an AXI4-Lite demo design (RDATA still combinational from the register file). Wrote a directed test that exposes it, registered RDATA at the handshake, and ran a 10-mutant campaign (9 detected; the miss documented as a testbench gap). | bug-injection campaign, e6952b3 |
| Validated a Docker Compose deployment from a clean checkout: health checks, worker drain, API restart, `pg_dump`/`pg_restore` drill. Browser E2E 2/2. The 3 unreachable base images were replaced by labelled local stand-ins. | deployment-report.md |
| Measured performance with repeated runs and 95% CIs: 64–69 scheduler tasks/s and about 210 sandboxed simulations/min on 2 vCPUs. Reported where earlier single-run claims did not reproduce. | benchmark-report.md |

Do **not** claim: production use, real GitHub/LLM/MinIO integration, UVM
support, exactly-once execution, or Docker as a complete isolation boundary.
