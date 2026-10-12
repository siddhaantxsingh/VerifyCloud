# Performance and cost

> **2026-10-10 re-measurement.** The audit repeated every benchmark (n=3–5,
> with confidence intervals, CPU/memory and an interleaved A/B against the
> original code). Current numbers and the claims that did not reproduce are
> in [audit-2026-10-08/benchmark-report.md](audit-2026-10-08/benchmark-report.md),
> with raw data in [benchmarks/audit-2026-10-10/](benchmarks/audit-2026-10-10/).
> The original single-run tables below are kept for history. New scripts:
> `bench/costs.ts` (container start, cold and cache-hit build) and
> `bench/ai-eval.ts` (labeled analyzer evaluation).

All numbers below were **measured** on one machine and are only meaningful
relative to it. Raw results with the recorded environment are in
[benchmarks/](benchmarks/); scripts are in `bench/`.

## Environment

| | |
| --- | --- |
| CPU | Intel Xeon @ 2.10 GHz, **2 vCPUs** |
| Memory | 7.8 GiB |
| OS / kernel | Linux 6.18 (VM) |
| Software | Node 22.22, PostgreSQL 16.15, Docker 29.8.2, Verilator 5.020 |
| Object storage | moto (S3 emulator) on localhost |
| Topology | API, PostgreSQL, object storage, workers **and** the load generator on the same host |

Because everything shares two vCPUs, these numbers are a lower bound for a
real deployment and say nothing about multi-host scaling.

## 1. Scheduler (`bench/scheduler.ts`)

Fake workers claim and complete immediately (no simulation): this isolates
queue, lease and bookkeeping overhead. 4 jobs × 101 tasks (1 build + 100 test
runs) per configuration.

| Workers | Tasks/s | Claim latency p50 / p95 / p99 (ms) | Complete p50 / p95 (ms) | Executed twice | All passed |
| ---: | ---: | --- | --- | ---: | :---: |
| 1 | 47.7 | 11.4 / 17.7 / 22.4 | 7.9 / 14.1 | 0 | yes |
| 5 | 72.5 | 56.4 / 78.4 / 88.1 | 9.7 / 18.2 | 0 | yes |
| 10 | 73.0 | 118.3 / 151.3 / 204.1 | 9.0 / 17.0 | 0 | yes |
| 25 | 73.9 | 255.7 / 345.7 / 357.9 | 51.2 / 80.1 | 0 | yes |

Reading: throughput plateaus at ~73 claim+complete cycles per second; extra
workers add queueing on the global claim lock (latency grows roughly
linearly), not throughput. No task ran twice across 1,616 claims. At
simulation lengths of seconds or more this is not the bottleneck (73 tasks/s
sustains ~730 concurrently running 10-second tests); see docs/scaling.md.

## 2. API latency (`bench/api.ts`)

Closed-loop clients for 10 s per scenario; one project with 30 finished jobs
of 13 tasks; bearer-token auth (each request validates the token in
PostgreSQL).

| Endpoint | c=1 rps / p95 | c=10 rps / p95 | c=50 rps / p95 / p99 | Errors |
| --- | --- | --- | --- | ---: |
| `GET /health` | 4,331 / 0.5 ms | 5,666 / 4.0 ms | 5,699 / 14.8 / 21.9 ms | 0 |
| `GET /projects/:id/jobs` | 332 / 4.5 ms | 619 / 25.1 ms | 761 / 91.6 / 107.2 ms | 0 |
| `GET /jobs/:id` | 415 / 3.9 ms | 743 / 21.2 ms | 826 / 81.9 / 94.8 ms | 0 |
| `GET /jobs/:id/tasks` | 386 / 4.0 ms | 766 / 20.0 ms | 775 / 90.7 / 107.0 ms | 0 |
| `GET /orgs/:org/dashboard` | 189 / 7.8 ms | 395 / 37.5 ms | 417 / 156.5 / 177.4 ms | 0 |
| `POST /projects/:id/jobs` (13 tasks) | 91 / 15.5 ms | 124 / 103.1 ms | — | 0 |

A single API process saturates around 750–830 authenticated reads/s on this
host (CPU-bound, shared with PostgreSQL); latency beyond that is queueing.

## 3. Real simulations in the sandbox (`bench/sandbox.ts`)

The demo design with the reference fix (all runs pass), one regression of 50
`random` runs (`OPS=400`), waveforms off, coverage on, compiled model from the
build cache. One worker with 1/5/10/25 concurrent sandbox slots; every run is
a fresh locked-down container.

| Sandbox slots | Wall time (s) | Runs/min | Per-run p50 / p95 (s) | Effective parallelism | Passed |
| ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 22.78 | 131.7 | 0.38 / 0.47 | 0.86 | 50/50 |
| 5 | 12.90 | 232.5 | 0.99 / 1.22 | 3.84 | 50/50 |
| 10 | 13.28 | 225.9 | 1.29 / 1.78 | 4.95 | 50/50 |
| 25 | 12.26 | 244.6 | 1.16 / 1.71 | 4.84 | 50/50 |

Per-run time is what the worker reports: model download, container start,
simulation, coverage/log upload. Throughput saturates at about 230–245 runs
per minute: the host has 2 vCPUs. More slots only make each run slower.

Other measured costs on this host:

* sandbox container start + teardown (`docker run --rm … true` with the
  sandbox flags): median 0.21 s (10 samples, 0.19–0.26 s);
* cold Verilator build of the demo (`--timing --assert --coverage-* --trace`,
  2 CPUs): 14.1 s (2 samples); with a build-cache hit the build task takes
  ~0.02 s;
* browser E2E (fail → analyze → verify fix), warm cache: 32 s; cold
  (fresh deployment, containerized API + worker): 48 s.

## Cost engineering

What drives cost and what VerifyCloud does about it:

| Cost driver | Control |
| --- | --- |
| Recompiling the same design | content-addressed build cache per organization (sources + config + toolchain); measured 14 s → 0.02 s |
| Container start per run (~0.2 s here) | negligible for runs ≥ seconds; for very short tests, raise `OPS`/test length or group seeds in one run |
| Idle workers | workers are stateless and drain on SIGTERM → safe to autoscale on `queue_depth` |
| Over-provisioned runs | per-test `cpu`/`memory_mb`; the scheduler packs tasks into worker capacity |
| Waveform storage | `on_failure` by default; per-kind retention capped by plan; size cap per waveform |
| Storage leaks | rows-first deletion with `storage_gc` so objects of deleted data are always removed |
| Noisy neighbors | per-organization concurrent task/job quotas, fair ordering by quota usage |
| AI spend | rule-based default; LLM tokens metered per org and capped by plan |

The usage ledger (`usage_records`: worker seconds, simulation seconds, CPU
seconds from cgroups, artifact bytes, AI tokens) is the input for billing; no
prices are applied in this repository.

## Reproducing

```bash
npx tsx bench/scheduler.ts > docs/benchmarks/scheduler.json
npx tsx bench/api.ts       > docs/benchmarks/api.json
npx tsx bench/sandbox.ts   # writes docs/benchmarks/sandbox.json (needs Docker + verifycloud-sim:verilator)
```
