# Requirements matrix (audit 2026-10-14)

Statuses: VERIFIED, IMPLEMENTED BUT UNVERIFIED, PARTIAL, FAILED, BLOCKED,
NOT IMPLEMENTED. "Baseline" is the state found on `main` (`9302deb`) before
any change in this audit; "Final" is branch `ccr-a6e6c567-y4w7k8`. Evidence
paths are under `docs/evidence/2026-10-14/` unless stated. All runs were on a
shared 4-vCPU container (load averages 10–45) plus GitHub-hosted CI.

| # | Requirement (intended scope) | Baseline | Final | Evidence / notes |
| --- | --- | --- | --- | --- |
| 1 | CI runs on GitHub for pushes and PRs | FAILED (workflow in a subdirectory, never ran) | VERIFIED that it runs; see CI status in AUDIT_2026-10-14.md | `/.github/workflows/ci.yml`; run 38705474615 executed 158 tests on GitHub (155 passed, the 2 failures are fixed in later commits) |
| 2 | Test suite passes against real MinIO | FAILED (65/143 failed: hard-coded `test`/`test` S3 credentials) | VERIFIED | `baseline-vitest-as-written.log`, `baseline-vitest-minio.log`, `server-suites-final.log` (78/78) |
| 3 | MinIO-specific storage: integrity, Range, interrupted uploads, memory budget | BLOCKED (previous audit used moto) | VERIFIED | `audit-storage.test.ts` 4/4, locally and on GitHub CI |
| 4 | Artifacts persist across a MinIO restart | BLOCKED | VERIFIED | `storage-minio-restart.log`; Compose: `compose-smoke-persist.log` (46/46 artifacts byte-identical after restarting MinIO, PostgreSQL and API) |
| 5 | Official Compose deployment (`postgres:16.10`, MinIO, built API/worker/sim images) | FAILED (pinned `minio/minio` tag no longer exists on Docker Hub; data dir not writable once replaced) | VERIFIED (API-level), browser E2E NOT RUN | `compose-build.log`, `compose-up.log`, `compose-smoke-run.log`: demo `full` regression FAILED as designed (only `random`, `rw_overlap` fail), coverage merged, analysis points at `rtl/axil_regs.sv:131`. MinIO image is `bitnamilegacy/minio:2025.4.22` (same release). Build needed the proxy override `deploy/build-behind-proxy.yml` on this network. Playwright not run here (no browser, disk) |
| 6 | Secure sandbox, Docker/runc: no network, read-only, no caps, non-root, limits | VERIFIED (previous audit) | VERIFIED | `sandbox.test.ts` in `baseline-vitest-minio.log`; CI run 38705474615 |
| 7 | Sandbox under gVisor (`runsc`) | BLOCKED | PARTIAL | `gvisor-sandbox.log`: 5/6 selected sandbox tests pass under runsc (hostile testbench, OOM, timeout, symlink C1, cache); fork bomb is contained but container removal took >20 s, so that test failed. `gvisor-adversarial.log`: `$fopen` and DPI-C cases pass |
| 8 | Lease fencing: stale-lease writes rejected | VERIFIED (in-process fake worker) | VERIFIED | `audit-scheduler.test.ts` M5/M6/chaos |
| 9 | Lease fencing with real worker processes: SIGKILL mid-run, SIGSTOP past lease, clock skew/step | NOT IMPLEMENTED (no such test) | VERIFIED | `lease-real.test.ts` 3/3 (`lease-real-1.log`, and on GitHub CI) |
| 10 | Worker-reported durations bounded (clock steps, hostile worker) | FAILED (negative usage; 500 + lost result on large values; NaN usage) | VERIFIED | failing first: `clock-before-fix.log` 3 failed → `clock-after-fix.log` 3 passed |
| 11 | Adversarial RTL: host-file `$fopen`/`include`, writes outside run dir, DPI-C libc imports, elaboration loop, oversized design | NOT IMPLEMENTED (no tests) | VERIFIED | `adversarial-rtl-2.log` 6/6; CI run 38705474615 5/6 (flood bound, see 12) |
| 12 | Output-file flood bounded on the host disk | NOT TESTED | PARTIAL | flood is stopped (RESOURCE_EXCEEDED) but overshoots: 122 MiB (local, 1 s sampling) and 154 MiB (GitHub, 250 ms sampling) for a 16 MiB budget. Open finding F6 |
| 13 | Upload path traversal / archive bombs | VERIFIED | VERIFIED | `security.test.ts` "rejects malicious source archives" |
| 14 | GitHub PR checks against a fake GitHub API: App JWT, installation tokens, HMAC webhooks, redelivery | VERIFIED (fake API) | VERIFIED (fake API) | `integrations.test.ts` GitHub block 8/8 (`github-after-o5.log`) |
| 15 | Concurrent redelivery creates one job / one check | NOT TESTED | VERIFIED | `integrations.test.ts` "concurrent redeliveries…" |
| 16 | Superseded PR runs cancelled (O5) | NOT IMPLEMENTED | VERIFIED | failing first: `github-before-o5.log` → `github-after-o5.log` |
| 17 | Real GitHub App on github.com | BLOCKED | BLOCKED | needs owner's App, key and public URL; steps in OWNER_ACTIONS.md §2 |
| 18 | Evidence-based (rule-based) failure analysis | VERIFIED | VERIFIED | demo E2E (`demo-e2e-after-timeout-fix.log`), Compose smoke analysis |
| 19 | LLM-assisted analysis with a real provider | BLOCKED | BLOCKED | no API key; deterministic analyzer is the default; stub tests pass |
| 20 | Demo E2E: failing regression → analysis → verified fix | FAILED (180 s test timeout on a loaded host) | VERIFIED | `demo-e2e-after-timeout-fix.log` (680 s) |
| 21 | Lint gate | PARTIAL (`tsc --noEmit` only) | PARTIAL | no ESLint/Prettier added; test files are not type-checked |
| 22 | Benchmarks re-measured | — | NOT RUN | shared host; numbers in `docs/benchmarks/` are from the previous audit and were not reproduced |

Counts (final): VERIFIED 16, PARTIAL 3, BLOCKED 2, NOT RUN 1 (benchmarks).
