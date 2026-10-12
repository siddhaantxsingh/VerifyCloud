# Local development

## Requirements

* Node.js 22+, npm 10+
* Docker (the worker runs every simulation in a container)
* PostgreSQL 16 and an S3-compatible endpoint — either via `docker compose`
  or your own (any S3 API: MinIO, LocalStack, moto, AWS)

## Option A: everything in Docker (one command)

```bash
cp .env.example .env          # replace every CHANGE-ME value
sudo mkdir -p /var/lib/verifycloud-worker
docker compose up --build
```

Open <http://localhost:8080> and log in with `DEMO_ADMIN_EMAIL` /
`DEMO_ADMIN_PASSWORD`. The seeded **AXI4-Lite demo** project is ready:
run the `full` regression, open a failing `random` test, click **Analyze this
failure**, then **Demo: verify the reference fix in a fresh run**.

> Verified status: the API and worker images were built and run (API +
> containerized worker driving the host Docker daemon) and the browser
> end-to-end test passed against them. The complete `docker compose up` with
> the official `postgres` and `minio` images could not be run in the
> environment this was built in (Docker Hub unreachable); `docker compose
> config` validates the file.

## Option B: host processes (fast iteration)

```bash
npm ci
docker build -t verifycloud-sim:verilator -f deploy/sim-image/Dockerfile .   # simulator image
# PostgreSQL + S3 endpoint running locally, then:
DATABASE_URL=postgres://postgres@127.0.0.1:5432/verifycloud_dev \
S3_ENDPOINT=http://127.0.0.1:9000 S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
scripts/dev-local.sh
```

For the web app with hot reload, run `npm run dev -w @verifycloud/web`
(port 5173, proxies `/api` to the API on 8080).

## Tests

```bash
npm run typecheck
npx vitest run                          # all suites (needs PostgreSQL, S3, Docker)
npx vitest run packages/shared          # pure units, no services
npx vitest run packages/worker/test/sandbox.test.ts   # real Docker + Verilator
E2E_BASE_URL=http://localhost:8080 npx playwright test -c packages/web/playwright.config.ts
```

Test environment variables: `TEST_DATABASE_ADMIN_URL` (default
`postgres://postgres@127.0.0.1:5432/postgres`, each test file creates and
drops its own database), `TEST_S3_ENDPOINT` (default `http://127.0.0.1:9000`,
each server gets a random bucket), `VC_TEST_PG_RESTART=false` to skip the
PostgreSQL-restart failure-injection test (it stops and starts the local
cluster with `pg_ctlcluster`).

## Repository layout

```text
packages/shared   config, detection, coverage, SV index, VCD, patch, tar (+ unit tests)
packages/server   API, scheduler, AI, GitHub, notifications (+ API/DB/security/integration tests)
packages/worker   worker, sandbox, Verilator adapter, harness (+ real-Docker and recovery tests)
packages/cli      verifycloud CLI (+ tests against a real server)
packages/web      React dashboard (+ Playwright E2E)
deploy/           Dockerfile (api, worker), sim-image/
examples/         axi4lite-demo (synthetic design with one intentional bug)
bench/            scheduler, API and sandbox benchmarks
action/           GitHub Action wrapper around the CLI
docs/             this documentation, ADRs, benchmark results
```

## Working on the demo design

`examples/axi4lite-demo` runs without the platform:

```bash
cd examples/axi4lite-demo
verilator --binary --timing --assert -Wno-fatal rtl/axil_regs.sv tb/axil_checker.sv tb/tb_top.sv --top-module tb_top
./obj_dir/Vtb_top +TEST=random +SEED=1 +OPS=400
```
