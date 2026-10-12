# Offline substitutes (test-only)

Stand-ins for the three third-party base images used by `docker-compose.yml`,
for environments that cannot pull from Docker Hub (the environment where the
2026-10-08 audit ran). They let the **whole compose file** — build contexts,
service wiring, health checks, the worker driving the host Docker daemon,
`WORK_DIR` path mapping, migrations, the seeded demo — be exercised from a
clean checkout. They are **not** for production.

| Official image | Substitute | Built from |
| --- | --- | --- |
| `postgres:16.10` | `vc-sub/postgres:16` | Ubuntu 24.04 + `postgresql-16` from the Ubuntu archive; honours `POSTGRES_USER/PASSWORD/DB`; ships `pg_isready` |
| `minio/minio:…` | `vc-sub/s3:moto` | Ubuntu 24.04 + `moto[server]` (an S3 API emulator, **not MinIO**); a tiny `mc ready local` shim answers the compose health check |
| `node:22-bookworm-slim` | `verifycloud-node:22` (pass as `NODE_IMAGE`) | Ubuntu 24.04 + official Node 22 binaries |

```bash
docker build --network host -t vc-sub/postgres:16 -f deploy/offline-substitutes/postgres.Dockerfile deploy/offline-substitutes
docker build --network host -t vc-sub/s3:moto     -f deploy/offline-substitutes/s3.Dockerfile       deploy/offline-substitutes
docker compose -f docker-compose.yml -f deploy/offline-substitutes/compose.override.yml up --build
```

Results obtained with these substitutes say nothing about MinIO itself or
the official PostgreSQL image.
