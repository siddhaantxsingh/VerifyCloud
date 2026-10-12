# VerifyCloud — initial audit (before implementation)

Date: 2026-10-07. Written before any platform code was written.

## 1. Existing repository

There was **no existing VerifyCloud repository**: the work starts from an
empty directory. Consequently there is no existing architecture,
functionality, CI, Dockerfile, documentation or RTL/UVM infrastructure to
inspect, and nothing to preserve. Every component described below is new.

## 2. Environment inspected (what can and cannot be verified here)

| Item | Finding | Consequence |
| --- | --- | --- |
| OS / hardware | Linux VM, 2 vCPUs, ~8 GB RAM | load tests limited to small worker counts; numbers are machine-specific |
| Verilator | 5.020 available from the Ubuntu archive (installed) | the one real simulator backend; features verified: `--timing`, `--assert` (concurrent SVA incl. `\|=>`, `$stable`), `--coverage` (line, branch, toggle, user/cover-property), `--trace` (VCD) |
| Verilator limitations found | `and` of two implications in one property unsupported (5.020); generated `--binary` main does not write coverage; `$stop`/`$fatal` call `std::abort()` by default; a TB driving at the rising edge races with the DUT | a custom harness `vc_main.cpp` is required (clean stop, coverage + VCD on failure); demo TB drives at the falling edge |
| Icarus, Questa, Xcelium, VCS | not available | **no adapters claimed** for them |
| Docker | daemon available; Docker Hub **blocked** | sandbox image built from an Ubuntu 24.04 rootfs created with `debootstrap` from the official archive and imported locally as `ubuntu:24.04`; the shipped Dockerfiles use the official images and are unverified against them here |
| PostgreSQL 16, Redis 7 | available | PostgreSQL is used; Redis is not required (see ADR-003) |
| MinIO / AWS S3 | MinIO download and Docker Hub blocked; no AWS account | S3 code path tested against **moto** (an S3-compatible emulator); MinIO in docker-compose is unverified here |
| GitHub | github.com blocked; no GitHub App | GitHub integration tested against a local **fake GitHub API** only; real GitHub unverified |
| LLM provider | no API key | OpenAI-compatible provider tested against a local stub server only; a deterministic rule-based analyzer is the default and is labelled as not an LLM |
| npm registry, PyPI, Ubuntu archive | reachable | dependencies installable |

## 3. Risks identified up front

* **Untrusted code execution**: user RTL/testbenches are C++-compiled and
  executed; compilation itself runs untrusted Makefile-free tool input.
  Must never run in the API process or with network/credentials.
* **Silent result loss**: a worker crash between "test finished" and "result
  stored" must not lose or duplicate results → leases with fencing tokens.
* **Double execution**: two workers claiming one task → atomic claim with
  `FOR UPDATE SKIP LOCKED` and per-claim lease tokens.
* **Tenant isolation**: every query must be scoped by organization; IDs must
  not be guessable-and-usable (IDOR).
* **Secret leakage**: GitHub tokens in clone URLs and git error output, secrets
  in logs, secrets sent to an LLM.
* **Resource exhaustion**: fork bombs, huge logs, huge waveforms, infinite
  simulations, disk filling.
* **Reproducibility**: results must record commit, config, toolchain image,
  flags and seed.
* **Fabrication risk**: coverage, benchmarks, AI accuracy and supported
  simulators must only be reported when measured/implemented.

## 4. Recommended architecture

```
Browser (React) ─┐                    ┌─> PostgreSQL (metadata, queue, events, audit, usage)
CLI / Action ────┼─> API (Fastify) ───┼─> S3-compatible object storage (logs, waveforms, coverage, models)
GitHub webhooks ─┘    │  SSE          └─> GitHub API (statuses/checks), LLM provider (optional)
                      │
             internal worker API (lease, heartbeat, upload, complete)
                      │
        Worker processes (N) ── docker sandbox per build/test (no network, no caps,
                                read-only rootfs, tmpfs, memory/CPU/PID limits)
```

* Monorepo, TypeScript end to end: `shared` (config schema, types),
  `server` (API, scheduler, GitHub, AI, retention), `worker` (sandbox,
  simulator adapters, parsers), `cli`, `web`.
* Queue in PostgreSQL (`SKIP LOCKED`, leases, fencing tokens, fair claim
  across organizations), events via `LISTEN/NOTIFY` → SSE with resumable ids.
* Workers never receive database credentials: they talk to an internal API
  with a worker token, and can only act on tasks they hold a lease for.
* A job = one build task + N test tasks (test × seed); the compiled model is
  an artifact shared by the job's tests and reused across jobs through a
  content-addressed build cache.
* `verifycloud.yaml` is mandatory and validated with line-numbered errors;
  auto-detection only proposes a configuration, it never silently guesses.

## 5. Implementation plan

1. Demo RTL (AXI4-Lite slave with an intentional, evidence-only-detectable
   bug), SVA checker, seeded self-checking testbench; Verilator harness.
2. Sandbox image; simulator adapter interface; Verilator adapter; parsers
   (results, assertions, coverage.dat, VCD index).
3. Database schema + migrations; auth (sessions, API keys/PATs), orgs, RBAC,
   projects, audit log, rate limiting, consistent errors, OpenAPI.
4. Queue/scheduler/worker: leases, heartbeats, retries, cancellation,
   timeouts, quotas, fair scheduling, idempotency; artifacts to S3.
5. GitHub App integration (webhooks, statuses/check runs), notifications,
   retention, usage ledger.
6. AI analysis (context builder, redaction, providers, validation of cited
   locations), source indexer, patch → fresh verification loop.
7. Web dashboard, SSE, waveform viewer, CLI, GitHub Action.
8. Tests (unit → E2E, security, failure injection, load), Docker deployment,
   documentation, final audit with measured results only.
