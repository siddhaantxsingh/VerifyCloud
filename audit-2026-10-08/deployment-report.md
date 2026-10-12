# F. Deployment report

## 1. Environment and blockers

| Item | Value |
| --- | --- |
| Host | 2 vCPU, 7.8 GiB RAM, Linux 6.18 (disposable cloud sandbox) |
| Docker | 29.8.2 (Compose v2 plugin) |
| Registry access | **Blocked**: Docker Hub, quay.io, ghcr.io, dl.min.io, download.docker.com. Ubuntu apt mirrors, npm and PyPI are reachable through a TLS-intercepting proxy. |
| Consequence | `docker compose up --build` from a clean checkout **cannot pull** `postgres:16.10`, `minio/minio:RELEASE.2025-04-22T22-12-26Z` or `node:22-bookworm-slim`. With official images, `cp .env.example .env; docker compose up --build` is therefore **BLOCKED**, not passed. |

## 2. What was run instead (substitutes, clearly labelled)

The Compose file was validated **unchanged**. Only the three unreachable
base images were replaced, through a separate override file:
`deploy/offline-substitutes/compose.override.yml`, test-only and
documented in its README.

| Official image | Stand-in (built locally from reachable sources) | Difference that matters |
| --- | --- | --- |
| `postgres:16.10` | `vc-sub/postgres:16`: Ubuntu 24.04 + PostgreSQL 16 from apt, scram auth, same env contract | none for the app (same major, same protocol) |
| `minio/minio:…` | `vc-sub/s3:moto`: moto server 5.2.3 + an `mc ready` shim for the health check | **moto keeps objects in memory**: objects do not survive a container restart; no erasure coding or real MinIO semantics |
| `node:22-bookworm-slim` | `verifycloud-node:22`: Ubuntu 24.04 + Node 22.22 | none observed |

Procedure (from a clean clone of the audit branch):

```bash
git clone verifycloud.bundle compose-clean && cd compose-clean && git checkout audit/2026-10-08
cp .env.example .env    # then: hex secrets, base64 SECRET_ENCRYPTION_KEY, DEMO_ADMIN_PASSWORD set
docker compose -f docker-compose.yml -f deploy/offline-substitutes/compose.override.yml up -d --build
```

## 3. Results

| Check | Result | Evidence |
| --- | --- | --- |
| Build of api, worker and sim images from a clean checkout | passed (after fixes D1–D3) | logs/compose-up.log |
| Health: postgres, minio (stand-in), api healthy; worker registered | passed | `docker compose ps`; worker log "worker registered" with toolchain digest |
| `/ready` | 200 | compose-ops.log |
| Browser E2E against the Compose stack (demo regression → failure → analysis → verified fix; unauthenticated access refused) | **2/2 passed** (53 s) | logs/e2e-compose.log |
| Persistence of PostgreSQL data across container and host restarts | passed (jobs = 2 before and after) | session log |
| Worker graceful stop (`docker compose stop -t 120 worker`) | SIGTERM → "draining" logged, exit within the grace period. It was idle (`running: 0`), so drain **with** a running task was verified separately by recovery.test.ts and the worker's drain code, not in Compose. | compose-ops.log |
| API restart under a connected worker | api healthy again; the worker's registration retries and recovers ("registration failed; retrying" → "worker registered") | compose-ops.log |
| Backup and restore (`pg_dump -Fc`, `pg_restore` into a new database) | passed: jobs 2/2, tasks 26/26, users 1/1, migrations `1,2` / `1,2` | compose-backup.log |
| Object storage persistence | **not verifiable with moto** (in memory). Real MinIO: **BLOCKED**. |  |

The Compose run above was made at commit `74b38ce`. Later commits change
application code, not deployment files: the demo, AI, uploads, webhooks
and scheduler lock mode. The stack was rebuilt and re-tested on the final
commit; see section 6.

## 4. Fixes made to deployment files

- D1: MinIO health check used `curl` (absent in recent images); now `mc ready local`.
- D2: `.env.example` suggested base64 secrets that break `DATABASE_URL`; now hex (base64 only for `SECRET_ENCRYPTION_KEY`).
- D3: the worker image's Docker CLI was too old for the daemon. The worker is now on Ubuntu 24.04 `docker.io`, and the `ARG` scope bug is fixed.
- D4: images pinned. The pinned MinIO tag could not be pulled here, so its existence is unverified.
- D5: CI MinIO pinned with a readiness wait (CI not executed).
- New: `UPLOAD_MEMORY_BUDGET_BYTES` documented in deployment.md.

## 5. Production checklist (what an operator must do)

| Item | State in this repo |
| --- | --- |
| Run with `NODE_ENV=production` | compose default is `development` for the demo; production refuses to start without `METRICS_TOKEN` (16+ characters), a strong encryption key and secure cookies |
| TLS termination and `TRUST_PROXY` set to the real hop count or CIDR | operator; the default trusts nothing |
| Secrets from a secret manager, not `.env` | operator |
| Worker hosts separate from API/DB hosts; gVisor or VM isolation for untrusted repositories | operator (see security report §1) |
| PostgreSQL backups (`pg_dump`/PITR) and restore drills | procedure verified once here (section 3) |
| Object storage with versioning and lifecycle rules | operator; retention deletes are implemented and tested against moto |
| Alerts on `/ready`, queue depth, `stale_task_reports_total`, `artifact_uploads_rejected_busy_total`, AI failures | metrics exist; alert rules are not provided |
| Log shipping (structured JSON logs) | operator |
| GitHub App and OAuth registration, webhook secret | operator; **untested against real GitHub** |
| SMTP | operator; outbox-tested only |

## 6. Final-commit rebuild

The stack was rebuilt from a **fresh clone at `6d4fb5d`**, the final code
commit, with the same substitutes and `.env`. Results:

- `docker compose … up -d --build --wait api` exited 0; postgres, minio (stand-in) and api were healthy, and the worker started.
- The browser E2E against the stack passed **2/2** (57 s): demo regression fails with 4/13 passed → rule-based analysis cites `rtl/axil_regs.sv:131` with high confidence → the reference fix is verified in a new run with 13/13 passed → compare shows no newly failing tests.
- The worker finished 28 tasks (two jobs of 1 build + 13 tests each).

Log: logs/compose-final-up.log and logs/e2e-compose-final.log in the audit
workspace.
