# Deployment

VerifyCloud has three runtime pieces plus two backing services:

| Piece | Image | Scaling | State |
| --- | --- | --- | --- |
| API (serves the web app too) | `deploy/Dockerfile` target `api` | horizontal, stateless | none |
| Worker | `deploy/Dockerfile` target `worker` | horizontal, one per dedicated host/VM | none (scratch only) |
| Simulator image | `deploy/sim-image` | pulled by worker hosts | — |
| PostgreSQL 16 | managed or self-hosted | primary (+ replicas for reads, not used yet) | all state |
| S3-compatible storage | AWS S3, MinIO, … | — | all blobs |

## Production checklist

Set `NODE_ENV=production`; the API refuses to start unless:

* `SECRET_ENCRYPTION_KEY` is set (32 random bytes, base64) — back it up;
  without it stored project secrets cannot be decrypted;
* `WORKER_REGISTRATION_TOKEN` is a long random value (≥ 24 characters);
* `COOKIE_SECURE=true` and `PUBLIC_URL` is `https://…`.

Also:

1. Terminate TLS in front of the API (load balancer / reverse proxy); forward
   `X-Forwarded-*` only from that proxy.
2. `ALLOWED_ORIGINS` = the dashboard origin(s). Cookie-authenticated writes
   from other origins are rejected.
3. Protect `/metrics` with `METRICS_TOKEN` (otherwise it answers loopback
   only).
4. Database: a dedicated role owning the schema; migrations run automatically
   at API start under an advisory lock (safe with several replicas).
5. Bucket: private, versioning optional, no public access, a lifecycle rule is
   not needed (VerifyCloud deletes expired objects itself).
6. Workers: dedicated hosts/VMs, nothing else on them (they control Docker);
   egress only to the API; consider `SANDBOX_RUNTIME=runsc` (gVisor) and
   rootless Docker (docs/worker-security.md). Set `WORKER_CPUS` /
   `WORKER_MEMORY_MB` to what sandboxes may use, leaving headroom for the OS.
7. `PUBLIC_DEMO=true` only on a deployment meant to be public. Visitors get
   a 2-hour `engineer` account in the demo organization (5 per IP per hour)
   and can run the seeded project and verify its pre-approved patch. Snapshot
   uploads, new projects, repository refs and settings changes are refused in
   the demo organization, and custom/AI patch submission is disabled on the
   whole deployment (tested in `security.test.ts`).
8. Backups: PostgreSQL point-in-time recovery; bucket replication if required.

## Environment reference

All variables with defaults are in `.env.example`. Notable ones:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://postgres@127.0.0.1:5432/verifycloud` | PostgreSQL |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | —, `verifycloud`, `us-east-1`, —, —, `true` | object storage (omit endpoint for AWS) |
| `LEASE_SECONDS` | 30 | task lease; workers heartbeat every third |
| `REAPER_INTERVAL_MS` | 5000 | lease expiry / deadline scan |
| `API_RATE_PER_MINUTE`, `AUTH_RATE_PER_MINUTE`, `JOB_CREATE_PER_MINUTE` | 600, 20, 120 | rate limits (per principal, per IP, per organization) |
| `MAX_UPLOAD_BYTES`, `MAX_ARTIFACT_BYTES` | 50 MiB, 512 MiB | request size limits |
| `UPLOAD_MEMORY_BUDGET_BYTES` | 1 GiB | artifact bytes the API buffers across concurrent uploads; beyond it uploads get 503 + Retry-After (workers retry) |
| `AI_OPENAI_BASE_URL`, `AI_OPENAI_API_KEY`, `AI_OPENAI_MODEL`, `AI_LOCAL_BASE_URL`, `AI_LOCAL_MODEL` | unset | optional LLM providers |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | unset | GitHub App and login |
| `SMTP_URL`, `MAIL_FROM` | unset | email (unset: logged) |

Worker variables: `API_URL`, `WORKER_REGISTRATION_TOKEN`, `SIM_IMAGE`,
`SANDBOX` (`docker`; `process` is development-only and refused unless
`ALLOW_UNSAFE_PROCESS_SANDBOX=true`), `SANDBOX_RUNTIME`, `WORKER_CPUS`,
`WORKER_MEMORY_MB`, `WORK_DIR`, `MAX_LOG_BYTES` (8 MiB kept),
`HARD_OUTPUT_BYTES` (64 MiB, run killed beyond), `MAX_OUT_DIR_BYTES`,
`MAX_WAVEFORM_BYTES`, `MAX_REPO_BYTES`, `SANDBOX_PIDS` (512),
`GIT_TIMEOUT_MS`, `DRAIN_TIMEOUT_MS`.

`WORK_DIR` must be the **same absolute path** on the worker host and inside
the worker container: the host's Docker daemon bind-mounts run directories
from it into sandboxes.

## Building images

```bash
docker build -f deploy/Dockerfile --target api    -t verifycloud-api .
docker build -f deploy/Dockerfile --target worker -t verifycloud-worker .
docker build -t verifycloud-sim:verilator -f deploy/sim-image/Dockerfile .
```

`NODE_IMAGE` (build arg) overrides the Node base image.

## Upgrades

Stateless processes can be replaced in any order. Migrations are forward-only
and additive; run one API instance of the new version first (it migrates), then
the rest. Workers: send SIGTERM; a worker stops claiming, finishes running
tasks (up to `DRAIN_TIMEOUT_MS`) and exits; anything unfinished is re-queued
when its lease expires.

## What was verified

* Images built from `deploy/Dockerfile` (with a locally built Node 22 base,
  since Docker Hub was unreachable) and run against PostgreSQL 16 and an S3
  emulator; the containerized worker drove the host Docker daemon; the browser
  E2E passed against that deployment.
* The production configuration guard (refuses http `PUBLIC_URL` with
  `NODE_ENV=production`) was observed.
* **Not verified here:** `docker compose up` with the official images, real
  MinIO/AWS S3, TLS termination, Kubernetes, any cloud deployment. No
  successful production deployment is claimed.
