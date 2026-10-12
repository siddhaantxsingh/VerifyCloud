# J. Handoff and roadmap

## State of the repository

- Branch `audit/2026-10-08` on top of `8fdc165` (master). Nothing pushed, merged or deployed.
- Delivered as `verifycloud.bundle` (all branches) and `verifycloud.zip` (working tree of the audit branch).
- Changes are in reviewable commits grouped by area. Most fixes come with a regression test; exceptions are listed in [engineering-audit.md](engineering-audit.md). Commit 45611f2 bundles eight related scheduler fixes; each has its own test.
- Database migration added: `002_audit_fixes.sql`, which adds `jobs.post_processed_at` with a backfill and a partial index, and `github_installations.sender_id`. It is forward-only and runs on API start like 001.
- Behaviour changes operators will notice:
  - Production now requires `METRICS_TOKEN` (16+ characters).
  - `TRUST_PROXY=true` means exactly one hop; set a hop count or a CIDR list for longer chains.
  - Read-only tokens can no longer write.
  - Org API keys are capped by their creator's current role, and stop working when the creator leaves the org.
  - Adding members needs a verified email when SMTP is configured or `REQUIRE_EMAIL_VERIFICATION=true`.
  - AI-generated patches are refused when they touch files outside the shown evidence, the failing checker or `verifycloud.yaml`.
  - Artifact uploads beyond `UPLOAD_MEMORY_BUDGET_BYTES` get 503 (workers retry).
  - The demo now has 6 tests (13 runs in `full`), and its reference fix registers RDATA.

## To finish what this environment could not

| Remaining check | What is needed | Commands |
| --- | --- | --- |
| Compose with official images | a host that can pull Docker Hub (`postgres:16.10`, `node:22-bookworm-slim`) and the MinIO image (verify the pinned tag exists, or use another S3-compatible service) | `cp .env.example .env` (fill secrets: hex, base64 for `SECRET_ENCRYPTION_KEY`); `docker compose up -d --build --wait api && docker compose up -d worker`; `E2E_PASSWORD=… npx playwright test -c packages/web/playwright.config.ts` |
| MinIO-specific storage tests | the stack above | `TEST_S3_ENDPOINT=http://127.0.0.1:9000 S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… npx vitest run packages/server/test/audit-storage.test.ts packages/worker/test/recovery.test.ts`; then restart MinIO and check that objects persist |
| Real GitHub App / OAuth | a GitHub App (App id, private key, webhook secret), OAuth app (client id/secret), a test repository, and a public HTTPS URL for webhooks | register the App per docs/github-integration.md; push a commit and open a PR on the test repo; check runs/statuses appear; redeliver a webhook from the App's "Advanced" page and confirm de-duplication |
| CI workflow | push the branch to a GitHub repository with Actions enabled (needs the owner's authorization) | the workflow runs on push/PR |
| LLM providers | an API key for an OpenAI-compatible endpoint or a local model server | set `AI_OPENAI_BASE_URL/API_KEY/MODEL` or `AI_LOCAL_*`; re-run `bench/ai-eval.ts` with the project's provider set to the LLM; run the P1 injection corpus against the real model |
| gVisor | a host with `runsc` installed and registered with Docker | `SANDBOX_RUNTIME=runsc` (see docs/worker-security.md); re-run `packages/worker/test/sandbox.test.ts` |
| SMTP | an SMTP relay | `SMTP_URL=smtp://…`; register a user and follow the email link |
| Multi-host benchmarks | separate DB, API and worker hosts | `npx tsx bench/scheduler.ts`, `bench/sandbox.ts` with `TEST_DATABASE_ADMIN_URL` pointing at the DB host |

## Roadmap (ordered by risk reduction)

1. Isolation: run workers on dedicated VMs and test gVisor; keep Docker as the inner layer.
2. Stream artifact uploads to S3 (multipart) instead of buffering, and reserve quota per upload to close the quota race (O1, O6).
3. Scheduler throughput: the global claim lock caps claims/s (see benchmark-report.md). Claim several tasks per call; shard the lock per pool/org; measure on separate DB hardware.
4. Testbench: add an outstanding-transactions test (two AWs before W) so the "AWREADY not gated" mutant is caught (O3); consider a protocol assertion on outstanding writes.
5. AI: real-LLM evaluation on the labeled set; extend rule coverage (scoreboard mismatches → address/strobe hypotheses) so fewer analyses abstain.
6. Auto-cancel superseded PR runs (O5).
7. ESLint + Prettier in CI; run CI on every PR (O4).
8. Accessibility audit with assistive technology.
9. FST waveforms; additional simulators (Icarus, commercial adapters); UVM only with a compatible simulator and real UVM tests.
