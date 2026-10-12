# B. Engineering audit (file by file)

Scope: the repository as delivered (`verifycloud.zip`, sha256 `bdd2767e…`,
identical to git `8fdc165`), audited on branch `audit/2026-10-08`.
Findings were reproduced before they were fixed wherever that was possible.
Most were reproduced by a regression test that failed before the fix. A few
fixes rest on code review only: S9, S10, D4, and D5 (the CI change, which
was not executed). Their evidence column says "review" or "not executed". Severity
uses the usual scale: Critical (host compromise or cross-tenant data access),
High (wrong results, lost work, or denial of service from one tenant or
worker), Medium, Low.

How the findings were found: three independent subagent reviews (worker
sandbox; scheduler/queue; security), then manual review of deployment, RTL
and AI, then adversarial tests, a full Compose deployment, bug injection and
benchmarks. Subagent findings were **not** accepted until they were
reproduced.

## Findings and fixes

| ID | Sev | File(s) | Defect (root cause) | Fix | Regression evidence | Commit |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | Critical | packages/worker/src/runner.ts | The worker read the simulation's output files (coverage, waveform, model) **from the host side with symlinks followed**. A testbench could write `coverage.dat -> /etc/shadow` (or a host secret path) and the worker uploaded the target. | `safefs.readUntrusted`: `O_NOFOLLOW`, `O_NONBLOCK`, `fstat` regular-file check, size limit | `sandbox.test.ts` "AUDIT C1" (canary file exfiltrated before the fix) + `audit-units` | dc652ea |
| C2 | High | runner.ts | A FIFO named like an output file blocked the worker's read forever, so the worker stopped taking work. | same as C1 (non-blocking open, regular files only) | "AUDIT C2" (it hung vitest before the fix) | dc652ea |
| H5 | High | sandbox.ts, main.ts | Containers of a crashed worker were never removed and kept consuming CPU and memory. | containers labelled `vc.sandbox`/`vc.owner`; orphans removed at startup | "AUDIT H5" | dc652ea |
| H6 | Medium | main.ts | Workers on one host shared a work directory, and stale task directories survived restarts. | per-worker work dir, wiped at startup; `removeTaskDir` chmods and retries and never throws | audit-units | dc652ea |
| H7 | High | sources.ts | The build cache key hashed only the files matched by the globs, so an `` `include `` header change reused a stale compiled model (wrong results). | key over every file in the source tree | audit-units "build cache key (H7)" | dc652ea |
| H8 | High | shared/config.ts | The simulator flag deny-list matched only exact `--flag` spellings: `-Mdir`, `-o`, `-f`, `+incdir+/etc`, `-CFLAGS`, `--compiler`… passed, letting a config change build outputs or pull host files into compilation. | canonicalisation (`canonicalFlag`) + a wider deny-list | audit-units "simulator flag deny-list" | dc652ea |
| M7w | Medium | sandbox.ts | The output collector kept only the head, so a long passing run lost its final `VC_SIM_END` verdict line and was misjudged. | head + 64 KiB tail, with an "N bytes omitted" marker | audit-units "output collection" | dc652ea |
| M8w | Low | sandbox.ts | NUL bytes in logs broke storage and search. | replaced with U+FFFD | audit-units | dc652ea |
| M9w | Medium | adapters/verilator.ts | A run could pass with failed self-checks (`VC_CHECK FAIL`) if it later reached `$finish` cleanly. | `passed` also requires no check failures | audit-units "pass/fail decision" | dc652ea |
| W1 | Medium | sources.ts | The git credential went into `argv` (visible in `ps`). The sha and URL were not validated, so option injection through the URL was possible. | `GIT_CONFIG_*` env; sha regex; https only; `--` before the URL | review + audit-units | dc652ea |
| H1 | High | worker api.ts/main.ts, routes/internal.ts | A worker marked offline (after a network partition) got 401 forever, never re-registered, and silently stopped working. | 401 `WORKER_REREGISTER`, and the worker re-registers | recovery.test.ts "AUDIT H1"; audit-scheduler H1 | 45611f2 |
| H2 | High | scheduler.ts | The reaper and the flaky-retry path re-queued tasks of already **finished or cancelled** jobs. | requeue only while the job is QUEUED/RUNNING and nothing is cancelled | audit-scheduler H2 | 45611f2 |
| H3 | High | scheduler.ts | `complete()` locked task then job, while `cancel()`/`reap()` locked job then tasks, which deadlocked. | one lock order everywhere: job row, then task rows | audit-scheduler H3 (a pg client holds the job lock) | 45611f2 |
| H11 | High | scheduler.ts, postjob.ts | Job rows were locked `FOR UPDATE`, which also blocks the `KEY SHARE` lock every foreign-key insert takes. `claim()` (holds a task row, then inserts a `job_events` row) and `cancel()` (holds the job row, waits for task rows) deadlocked, and the user got a 500. Found in the **full test run after the H3 fix**. | job rows locked `FOR NO KEY UPDATE` (same mutual exclusion, compatible with FK checks) | audit-scheduler H11 (deterministic; 500 before the fix) | 1c63d53 |
| M4 | Medium | scheduler.ts | A claim waited for a job row lock while holding the global claim lock, so every claim queued behind it. | `FOR … SKIP LOCKED` for the QUEUED→RUNNING flip | audit-scheduler | 45611f2 |
| M5 | Medium | routes/internal.ts, scheduler.ts | A retried completion (the response was lost) got `LEASE_LOST`, so the worker logged a failure for a recorded result. | an already-recorded completion with the same token returns the recorded outcome | audit-scheduler M5 | 45611f2 |
| M6 | High | artifacts.ts | Artifact fencing was check-then-insert: an upload that finished after the lease was lost still attached a stale attempt's artifact. | `INSERT … WHERE EXISTS (lease still held)`; 0 rows → 409 and the object is deleted | audit-scheduler M6 | 45611f2 |
| M7s | Medium | scheduler.ts | Flaky-test retries consumed the infrastructure retry budget. | the flaky requeue extends `max_attempts` | audit-scheduler "flaky budget" | 45611f2 |
| M8s | Medium | events.ts | `job_events` ids are allocated at INSERT and committed later. The SSE hub tracked "max id seen", so a late-committing transaction's event was skipped forever. | rescan window plus a per-subscriber seen set | audit-scheduler M8 | 45611f2 |
| M8b | High | events.ts | **Introduced by the first M8 fix, found by benchmarking**: every NOTIFY re-read a 120 s window (O(rate × window), costing 25% scheduler throughput at 1 worker and 12–17% at 5–25). Past 2000 rows in the window, new events were not delivered at all until the window slid. | gap tracking: skipped sequence ids watched for 120 s; each drain fetches new ids plus open gaps | audit-scheduler M8b (failed before) + interleaved A/B benchmark | 2183d6c |
| M9s | High | postjob.ts, app.ts | Post-job side effects (notifications, GitHub check completion) ran in memory after commit: a crash lost them, and a retry duplicated them. | `jobs.post_processed_at` marker set in the outbox transaction, plus a periodic sweep (migration 002) | audit-scheduler M9 | 45611f2 |
| S1 | Critical | access.ts | An org API key kept its privileges after its creator was demoted, removed or disabled (tested in 3 variants). | key role capped by the creator's **current** membership; invalid without one | audit-security S1 ×3 | 7b1cfec |
| S2 | High | routes/orgs.ts | API keys could manage members, and admins could create owners. | member management requires a user; owner/admin grants require an owner | audit-security S2 | 7b1cfec |
| S2b | Medium | routes/orgs.ts | Last-owner race: two concurrent demotions could leave an org without an owner. | owner rows locked before counting | audit-security | 7b1cfec |
| S3 | High | app.ts | `TRUST_PROXY=true` trusted every hop, so a spoofed `X-Forwarded-For` bypassed per-IP auth rate limits. | 1-hop function, hop count or CIDR list | audit-security S3 | 7b1cfec |
| S4 | Medium | config.ts | `/metrics` could be exposed without auth in production. | production requires a METRICS_TOKEN of at least 16 characters | audit-security S4 | 7b1cfec |
| S5 | High | app.ts | Read-only tokens could make write requests. | non-GET with a read-only token → 403 | audit-security S5 | 7b1cfec |
| S6 | High | netguard.ts | The SSRF guard used one BlockList for v4 and v6. The `::ffff:0:0/96` entry made it **block every IPv4 address**, so webhooks to public IPv4 never worked. NAT64/6to4/documentation ranges were missing. | separate v4/v6 lists; embedded-IPv4 extraction; added ranges | audit-security S6 | 7b1cfec |
| S8 | High | routes/auth.ts | GitHub OAuth `state` was not bound to the browser, which allowed login CSRF. | `vc_oauth` cookie compared in constant time | audit-security S8 | 7b1cfec |
| S11 | High | routes/webhooks.ts, routes/projects.ts | An installation claim matched the GitHub **login**, which can be renamed and re-registered (takeover). | match the immutable `sender.id` (migration 002) | audit-security S11; integrations rename case | 7b1cfec |
| S12 | Medium | web/src/nav.ts | Open redirect through `?next=`. | same-origin check through URL parsing | web nav.test.ts | 7b1cfec |
| S9 | Low | ai/service.ts | Internal errors (storage keys) were stored in analyses visible to viewers. | generic message; details in server logs | review | 7b1cfec |
| S10 | Medium | ratelimit.ts | The bucket map `clear()`ed when full, resetting every limit. | LRU eviction | review | 7b1cfec |
| S7 | Medium | routes/jobs.ts, routes/ai.ts | Re-run and patch verification were not rate-limited (CPU amplification); gunzip was unbounded. | rate limits; `maxOutputLength` | review + audit-security | 7b1cfec |
| S13 | High | routes/internal.ts | Artifact uploads are buffered in memory (up to 512 MiB each) with no concurrency bound, so the API's memory could be exhausted. | `UPLOAD_MEMORY_BUDGET_BYTES` (503 + Retry-After; the worker retries) | audit-storage S13 (failed before the fix) | 44bd38e |
| P1 | High | ai/llm.ts | Prompt injection: untrusted text (a `$display`, a comment, a file name, a commit message) could print `<<<END LOG_EXCERPT>>>` and continue **outside** the data block. | per-request random id on delimiters; `<<<`/`>>>` in data defanged | audit-ai (unit) + integrations "AUDIT P1" | 262205a |
| P2 | High | ai/service.ts | A model-generated patch could edit any file, including the failing checker (removing the assertion "passes" the verification job) or `verifycloud.yaml`. | AI patches may only edit shown files, never the failing assertion's file or the config, and never create, delete or rename files | integrations "AUDIT P2" | 262205a |
| P3 | Medium | shared/redact.ts | Redaction missed GitLab and Google API keys and prefixed assignments (`aws_secret_access_key`, `DB_PASSWORD`, `AccountKey`). | patterns added; corpus test, including no false positives on RTL and logs | shared audit-redact | 23c4dda |
| G1 | High | routes/webhooks.ts | A delivery was recorded before processing. If processing failed or the process died, every redelivery was answered "duplicate" and the commit was never verified. | `error` status; stale or failed deliveries are reprocessed (job creation stays idempotent) | integrations "AUDIT G1" (failed before the fix) | 853b282 |
| D1 | High | docker-compose.yml | The MinIO health check used `curl`, which recent images lack, so the stack never became healthy. | `mc ready local` | compose deployment (substitutes) | 4032087 |
| D2 | High | .env.example | It suggested base64 secrets; `/`, `+` and `=` break `DATABASE_URL`. | hex guidance (base64 only for the encryption key) | compose deployment | 4032087 |
| D3 | High | deploy/Dockerfile | The worker image's Docker CLI was too old for the host daemon's API. A mid-file `ARG` was out of scope. | worker on ubuntu:24.04 `docker.io`; global ARG | compose deployment | 4032087 |
| D4 | Medium | docker-compose.yml | Images were unpinned. | pinned tags (the MinIO tag could **not** be pulled to verify) | review | 4032087 |
| D5 | Medium | .github/workflows/ci.yml | `bitnami/minio:latest` was unpinned and had no readiness check. | pinned MinIO started as a step with a readiness wait | **not executed** | 008ee31 |
| R1 | High | examples/axi4lite-demo/fix-rdata-stable.patch | The reference fix decoded the registered address but left RDATA combinational from the register file, so a write landing during an R stall changed RDATA. | register RDATA/RRESP at the AR handshake; new test `rw_overlap` | bug-injection campaign: `rw_overlap` fails with the old patch | e6952b3 |
| R2 | Low | tb/axil_checker.sv | `cov_aw_before_w` / `cov_w_before_aw` did not check order. | track which channel was accepted first | review + campaign | e6952b3 |
| T1 | Low | integrations.test.ts | Two order-dependent flakes (failed in 1 of 4 runs): an assertion without waiting, and the fake worker taking another test's task. | wait; filter by job | 3 consecutive green runs | 853b282 |

## Open findings (not fixed)

| ID | Sev | Where | Issue | Why open / plan |
| --- | --- | --- | --- | --- |
| O1 | Medium | artifacts.ts | Quota check is read-then-write; concurrent uploads can overshoot an org quota by up to (concurrent uploads × artifact size). | needs a reservation row per upload; roadmap |
| O2 | Medium | deploy | Docker (runc) is the isolation boundary; a kernel or runtime escape compromises the worker host. gVisor (`runsc`) is supported by configuration but was **not tested** here. | run workers on dedicated hosts/VMs; test gVisor |
| O3 | Medium | tb_top.sv | Testbench gap: the master never has two write addresses outstanding, so an injected "AWREADY not gated" defect is not detected. | add an outstanding-transactions test |
| O4 | Low | repo | "lint" is `tsc --noEmit` only; no ESLint, no formatter. | add ESLint + Prettier in CI |
| O5 | Low | webhooks.ts | Superseded PR runs (new push to the same PR) are not cancelled automatically (cost, not correctness). | roadmap |
| O6 | Info | artifacts | Uploads are buffered in memory (now bounded by S13) instead of streamed to S3. | stream with multipart upload |
| O7 | Info | worker | No exactly-once execution: a partitioned worker can still run a stale attempt; only one result is recorded. This is by design (ADR-008) and is documented. | — |

## Change log (audit branch, in order)

```
dc652ea fix(worker): never follow symlinks/FIFOs in sandbox output; orphan cleanup; bounded out-dir scan; log tail; cache key over full tree
45611f2 fix(scheduler): consistent lock order, no requeue into finished jobs, idempotent completion route, atomic upload fencing, late-commit events, durable post-job, worker re-registration
fd7ca77 test(scheduler): randomized chaos test with invariants
7b1cfec fix(security): key/member privilege boundaries, owner race, OAuth login CSRF, SSRF ranges (and all-IPv4 block bug), read-only tokens, proxy trust, open redirect
4032087 fix(deploy): worker image on Ubuntu 24.04, MinIO health check without curl, pinned images, hex secrets guidance; offline substitutes for compose validation
74b38ce fix(offline-substitutes): absolute PostgreSQL paths in the stand-in entrypoint
1c63d53 fix(scheduler): lock job rows FOR NO KEY UPDATE (cancel/claim deadlock via FK KEY SHARE)
e6952b3 fix(demo): register RDATA at the AR handshake; rw_overlap test; ordered AW/W cover points
2888bb8 bench: labeled bug-injection evaluation of the rule-based analyzer
262205a fix(ai): prompt-injection hardening — nonce-tagged, defanged data blocks; AI patches limited to shown RTL files
23c4dda fix(redact): GitLab and Google API keys, prefixed secret assignments; corpus test
853b282 fix(webhooks): reprocess redeliveries whose processing failed or died; de-flake integration tests
44bd38e fix(api): bound memory used by concurrent artifact uploads; storage tests
008ee31 ci: pinned MinIO started as a step with a readiness wait
2183d6c fix(events): track sequence gaps instead of rescanning a window
(docs)  benchmarks, reports, documentation updates
```

`git log audit/2026-10-08 ^8fdc165` in the bundle is authoritative.
