# Owner actions

Things only the repository owner can do: they need accounts, secrets, public
hosts or money. Each item says what to run and what success looks like.
Everything else in the scope was done or tested in the 2026-10-14 audit (see
[AUDIT_2026-10-14.md](AUDIT_2026-10-14.md) and
[REQUIREMENTS_MATRIX.md](REQUIREMENTS_MATRIX.md)).

## 1. Check that CI runs and passes on GitHub

The workflow now lives in the repository root (`/.github/workflows/ci.yml`).
It runs on pushes to `main` and `ccr-*` branches and on pull requests.

1. Open the repository's **Actions** tab. Make sure Actions are enabled
   (Settings → Actions → General → "Allow all actions").
2. Open the latest `ci` run for branch `ccr-a6e6c567-y4w7k8`.

Success: job `test` is green (typecheck, lint, build, simulation image, full
vitest suite including Docker sandbox tests), then `images-and-e2e` is green
(Compose stack + Playwright). If `images-and-e2e` fails only at
`npx playwright install --with-deps`, that is a runner network problem, not the
product; re-run the job.

## 2. Register a real GitHub App (PR checks)

Only you can create the App and hold its private key. The code path was tested
against a local fake GitHub API (App JWT signature check, installation tokens,
HMAC-signed webhooks, redelivery, concurrent redelivery, superseded-run
cancellation). Real GitHub was never contacted.

You need a public HTTPS URL for the API (for example a small VM with the
Compose stack behind a reverse proxy, or a tunnel such as
`cloudflared tunnel --url http://localhost:8080` for a test).

1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.
   - Homepage URL: your public URL.
   - Webhook URL: `https://<host>/api/v1/webhooks/github`.
   - Webhook secret: output of `openssl rand -hex 32`.
   - Repository permissions: Contents **Read**, Metadata **Read**, Checks
     **Read and write**, Commit statuses **Read and write**, Pull requests
     **Read and write**.
   - Subscribe to events: **Push**, **Pull request** (Installation events are
     always sent).
   - Optional login: enable "Request user authorization (OAuth) during
     installation", callback `https://<host>/api/v1/auth/github/callback`.
2. After creating it: note the **App ID**; "Generate a private key" (downloads
   a `.pem`); for login, note the client id and generate a client secret.
3. Put these in `.env` on the API host:
   ```
   GITHUB_APP_ID=<app id>
   GITHUB_APP_PRIVATE_KEY="$(awk '{printf "%s\\n", $0}' app.private-key.pem)"
   GITHUB_WEBHOOK_SECRET=<the secret from step 1>
   GITHUB_OAUTH_CLIENT_ID=<client id>
   GITHUB_OAUTH_CLIENT_SECRET=<client secret>
   PUBLIC_URL=https://<host>
   ```
   then `docker compose up -d api`.
4. Install the App on a test repository that contains a `verifycloud.yaml`
   (copy `examples/axi4lite-demo`). In VerifyCloud: log in with GitHub, then
   Organization settings → **Claim installation** (installation id is in the
   URL of the App's installation page), then Project settings → GitHub
   repository `owner/repo`, enable PR checks.
5. Open a pull request.

Success:
- The App's **Advanced** page lists the deliveries with response 200.
- The PR shows a check "VerifyCloud regression" (queued → completed) and a
  commit status `verifycloud/regression`.
- Push a second commit to the PR: the first run becomes **Cancelled** and its
  check completes as "cancelled"; the new head gets a new run.
- On the Advanced page, **Redeliver** an old delivery: the response body says
  `"duplicate": true` and no second job appears.

## 3. LLM-assisted analysis (optional)

Blocked here: no API key. The deterministic rule-based analyzer is the default
and needs nothing.

```
AI_OPENAI_BASE_URL=https://api.openai.com/v1   # or any OpenAI-compatible endpoint
AI_OPENAI_API_KEY=<key>
AI_OPENAI_MODEL=<model>
```
Then `npx tsx bench/ai-eval.ts` with the demo project set to the LLM provider.
Success: the report lists, per labeled case, the model's verdict next to the
label; compare it with the rule-based baseline in `docs/benchmarks/ai-eval.json`.
This costs API money; budget it first.

## 4. Production isolation for workers

The sandbox was tested with Docker (runc) and with gVisor (`runsc`) on this
audit's machine. For production:

1. Run workers on dedicated VMs that hold no other secrets (the worker controls
   the host's Docker daemon).
2. Install gVisor on each worker VM
   (https://gvisor.dev/docs/user_guide/install/), register it:
   `sudo runsc install && sudo systemctl reload docker`, and set
   `SANDBOX_RUNTIME=runsc` for the worker.
3. Run `SANDBOX_RUNTIME=runsc npx vitest run packages/worker/test/sandbox.test.ts packages/worker/test/adversarial-rtl.test.ts`
   on one worker VM. Success: all tests pass.

## 5. SMTP

Set `SMTP_URL=smtp://user:pass@relay:587` and `MAIL_FROM`. Register a user.
Success: the verification email arrives and its link verifies the address.

## 6. MinIO image source

`minio/minio` is no longer on Docker Hub. Compose and CI use
`bitnamilegacy/minio:2025.4.22` pinned by digest (same MinIO release). That
repository is an archive and will not get security fixes. Decide on a long-term
S3 service: a maintained MinIO build you trust, another S3-compatible server,
or AWS S3 (`S3_ENDPOINT` unset, real credentials). Set `MINIO_IMAGE` in `.env`
to switch the Compose image.
