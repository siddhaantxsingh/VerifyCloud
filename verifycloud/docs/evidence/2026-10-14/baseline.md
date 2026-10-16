# Baseline, 2026-10-14

Branch `ccr-a6e6c567-y4w7k8`, started from `main` at `9302deb`.
Machine: shared Linux container, 4 vCPU, 15 GiB RAM, no GPU. Other agents ran
builds on the same machine at the same time. Load averages are recorded in
each log (they ranged from about 10 to 45 on 4 vCPUs), so every timing below is
a shared-host timing, not a benchmark.

## Environment found

| Item | Result | How checked |
| --- | --- | --- |
| Node / npm | v22.22.0 / 10.9.4 | `node -v; npm -v` |
| Verilator (host) | 5.020 | `verilator --version` |
| Docker daemon | not running at first; started with `dockerd`; works (overlayfs, cgroup v1) | `docker info` |
| Image pulls | `postgres:16.10`, `node:22-bookworm-slim`, `ubuntu:24.04` pulled | `docker pull` |
| `minio/minio:RELEASE.2025-04-22T22-12-26Z` (the pinned compose tag) | **cannot be pulled**: "pull access denied … repository does not exist"; Docker Hub API returns 404 for `minio/minio`; `quay.io` and `dl.min.io` are blocked by this network's proxy (403) | `docker pull`, `curl` |
| Replacement MinIO | `bitnamilegacy/minio:2025.4.22` contains `minio version DEVELOPMENT.2025-04-22T22-12-26Z (commit-id=0d7408fc…)`, the same release; digest `sha256:50cec18a…` | `docker run … minio --version` |
| PostgreSQL | local PostgreSQL 16.15 cluster, trust auth on 127.0.0.1 | `psql -c "select version()"` |
| gVisor | not installed at first; release 20260928.0 downloaded from `storage.googleapis.com/gvisor` (sha512 verified), installed to `/opt/gvisor`, registered as Docker runtime `runsc` | `runsc --version`, `docker run --runtime=runsc` |

## Commands and results

| Step | Command | Result | Log |
| --- | --- | --- | --- |
| Install | `npm ci --no-audit --no-fund` | OK, 206 packages, 6 s | `npm-ci.log` |
| Typecheck | `npm run typecheck` | exit 0 | `typecheck.log` |
| Lint | `npm run lint` (this is `tsc --noEmit` only; no ESLint) | exit 0 | `lint.log` |
| Simulation image | `docker build -t verifycloud-sim:verilator -f deploy/sim-image/Dockerfile .` | OK, 67 s | `sim-image-build.log` |
| Full suite, as written, against real MinIO | `TEST_DATABASE_ADMIN_URL=… TEST_S3_ENDPOINT=http://127.0.0.1:9000 S3_ACCESS_KEY_ID=test S3_SECRET_ACCESS_KEY=testtesttest npx vitest run` | **65 failed / 78 passed (143), 9 of 14 files failed**, 199 s | `baseline-vitest-as-written.log` |
| Same, after reading S3 test credentials from the environment (commit `1f73bc6`) | same command | **142 passed / 1 failed (143)**, 848 s, load 11.7 at start | `baseline-vitest-minio.log` |
| The one failure, after its timeout fix (commit `a0fd847`) | `npx vitest run packages/worker/test/sandbox.test.ts -t "seeded demo"` | 1 passed, 680 s | `demo-e2e-after-timeout-fix.log` |

### Why 65 tests failed as written

The test helpers hard-coded S3 credentials `test`/`test`. MinIO refuses a root
password shorter than 8 characters (`MINIO_ROOT_PASSWORD length at least 8
characters`), so a MinIO started with `test` cannot exist, and a MinIO with a
longer secret rejects every request signed with `test`
(`SignatureDoesNotMatch`). The previous audit ran against moto, which accepts any
credentials. The CI workflow set `S3_SECRET_ACCESS_KEY=testtesttest` but the
helpers ignored it, so CI could not have passed either (and it never ran: it
was not in the repository root).

### Why the demo end-to-end test failed

Its own waits allow 600 s per job, but vitest's global `testTimeout` is 180 s.
Under load the test needed about 590 s (two Verilator builds and 13
simulations), so vitest cut it off. The test now has its own timeout.

## Existing benchmarks

Not re-run as benchmarks: the machine was shared with load averages of 10–45 on
4 vCPUs, so any throughput number would measure the other agents. The numbers in
`docs/benchmarks/` and `docs/audit-2026-10-08/benchmark-report.md` are from the
previous audit's environment and were **not reproduced** here.
