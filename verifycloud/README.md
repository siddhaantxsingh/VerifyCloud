# VerifyCloud (project directory)

This directory holds the VerifyCloud source: `packages/` (server, worker, CLI,
web, shared), `deploy/`, `examples/`, `bench/` and `docs/`.

The full README (overview, architecture, quick start, results, verification,
limitations) is at the repository root: [../README.md](../README.md).

Quick start from this directory:

```bash
cp .env.example .env            # replace every CHANGE-ME value
sudo mkdir -p /var/lib/verifycloud-worker
docker compose up --build       # then open http://localhost:8080
```

Development: `npm ci && npm run typecheck && npm run build && npm test`
(see [docs/testing.md](docs/testing.md) for the services the test suite needs).

Documentation index: [docs/](docs/) · Status: [docs/REQUIREMENTS_MATRIX.md](docs/REQUIREMENTS_MATRIX.md)
· Owner-only steps: [docs/OWNER_ACTIONS.md](docs/OWNER_ACTIONS.md) · License: [MIT](LICENSE)
