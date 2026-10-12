# E. Benchmark report

All runs were made on one host. It ran the API, PostgreSQL 16, the S3
emulator (moto), the workers, the Docker sandboxes and the load generator.
The host had 2 vCPUs (shared cloud VM), 7.8 GiB RAM, Linux 6.18, Node 22.22,
Docker 29.8.2 and Verilator 5.020, on 2026-10-10. Raw data, scripts and the
aggregation are in `docs/benchmarks/audit-2026-10-10/`: per-run JSON,
`/usr/bin/time -v` output, `vmstat` samples, `run-all.sh`, `aggregate.py` and
`summary.json`. CI95 is mean ± t(n−1)·s/√n. With n = 3–5 these intervals are
wide; they are reported, not hidden.

## 1. Claims vs measurements (final code, `audit/2026-10-08` HEAD)

| Claim (README / performance.md) | Measured | Verdict |
| --- | --- | --- |
| Scheduler 47.7 tasks/s, 1 worker | **46.4** ± (CI95 44.0–48.9), n=5 | reproduced |
| Scheduler 72.5 tasks/s, 5 workers | **65.5** (63.1–68.0), n=5 | **not reproduced**: about 10% lower; the claim is outside the CI |
| Scheduler 73.0 tasks/s, 10 workers | **68.8** (64.2–73.5), n=5 | at the CI edge |
| Scheduler 73.9 tasks/s, 25 workers | **64.4** (58.6–70.3), n=5 | **not reproduced**: about 13% lower |
| "~73 claims/s, flat from 5 to 25 workers" | 64–69 tasks/s, flat within noise from 5 to 25 | shape reproduced, level lower |
| "No duplicates in 1,616 claims" | 0 tasks claimed twice in **8,080** claims (20 runs × 404) | reproduced. This workload has no lease expiries, so it says nothing about execution after a partition; see §4 |
| Sandbox ~230–245 runs/min at saturation | **206–215** runs/min (5/10/25 slots), CI95 upper bounds 225–240 | **not reproduced** at the claimed level; saturation from 5 slots reproduced |
| Sandbox 131.7 runs/min, 1 slot | **119.3** (107.7–130.9), n=3 | about 10% lower |
| Container start + teardown 0.21 s median | **0.23 s** median (p95 0.27), n=20 | approximately reproduced |
| Cold demo build 14.1 s | **17.6 s** median (range 17.5–18.0), n=5 | not comparable: the demo testbench grew in this audit (`rw_overlap`, cover logic) |
| Cache-hit build ~0.02 s | **0.015 s** median (range 0.013–0.016), n=5 | reproduced |

The probable reason the throughput numbers came out lower is host variance.
The same baseline code (`8fdc165`) measured 45.6–50.5 tasks/s at 1 worker
and 61–73 at 5–25 workers in interleaved runs on this host during one hour
(§2). The original claims were single runs with no variance reported.

## 2. Regression found by benchmarking, and fixed

An interleaved A/B (baseline `8fdc165` vs audit branch, alternating, same
host, 4 pairs) showed the audit branch **25% slower at 1 worker** and
17% slower at 5–10 workers:

| Workers | baseline | audit (before fix) | audit (after fix, 3 pairs) | baseline (same 3 pairs) |
| --- | --- | --- | --- | --- |
| 1 | 45.6 | 34.1 | 47.6 | 50.5 |
| 5 | 64.9 | 54.2 | 72.8 | 70.7 |
| 10 | 65.8 | 54.8 | 67.4 | 73.3 |
| 25 | 61.2 | 53.9 | 64.8 | 66.6 |

Cause: the first audit fix for late-committing events (M8) re-read a
120-second window of `job_events` (up to 2000 rows) on every NOTIFY. That
cost O(event rate × window). Worse, beyond 2000 rows in the window it
returned only old rows, so **new events stalled**. The stall was reproduced
by test M8b, which failed before the fix. It is now fixed by gap tracking
(commit "fix(events): track sequence gaps…"). After the fix the audit
branch is within run-to-run noise of the baseline (differences of −8% to
+3%, in both directions, with n=3 pairs).

## 3. API latency (closed-loop clients, 10 s per scenario, n=3 runs)

| Scenario | c=1 rps | c=10 rps | c=50 rps | p95 at c=10 (ms) | errors |
| --- | --- | --- | --- | --- | --- |
| GET /health | 3567 | 4077 | 3783 | 5.8 | 0 |
| GET project jobs | 328 | 621 | 586 | 24.3 | 0 |
| GET job | 445 | 784 | 715 | 19.0 | 0 |
| GET job tasks | 426 | 751 | 683 | 20.2 | 0 |
| GET org dashboard | 209 | 412 | 401 | 36.0 | 0 |
| POST create job (13 tasks) | 99 | 140 | — | 93.3 | 0 |

Throughput peaks at c=10; at c=50 latency grows and throughput is flat or
lower, as expected on 2 vCPUs. Per-scenario CI95 is in `summary.json`.

## 4. Resources and contention

- **Benchmark process** (API + workers + load generator in one Node process): peak RSS 263–310 MiB; CPU 48–70% of one core. Docker containers and PostgreSQL are separate processes and are not included.
- **Host**, from vmstat over the whole run (215 samples): mean idle 32.6%, I/O wait 1.1%, minimum free memory 5.6 GiB. CPU is the bottleneck; memory is not.
- **Contention**: claim p95 grows linearly with workers (17.9 ms at 1 → 84 → 169 → 368 ms at 25). That is the global claim lock (advisory lock 7471002) serialising claims, so throughput is flat while latency grows. Roadmap: batch claims, shard the lock.
- **Recovery time**: measured in the failure-injection tests (recovery.test.ts). An API restart and a 3-second PostgreSQL outage both complete the running simulation without a retry (`attempt: 1`); readiness returns to 200 after PostgreSQL restarts (the test waits up to 30 s). A precise MTTR distribution was not measured.
- **Upload memory**: one 60 MB artifact upload round-trips byte-exact; concurrent uploads are now bounded by `UPLOAD_MEMORY_BUDGET_BYTES` (S13).

## 5. Not measured

- Multi-host deployments; PostgreSQL on dedicated hardware; network latency between components.
- Long-duration soak (hours) and memory growth over time.
- MinIO / AWS S3 throughput (moto only).
- Workers using gVisor.
