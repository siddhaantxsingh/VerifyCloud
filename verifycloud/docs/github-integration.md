# GitHub integration

Two independent ways to run VerifyCloud from GitHub:

1. **GitHub App** (recommended): pushes and pull requests start runs; results
   appear as a check run and a commit status. No workflow file needed.
2. **GitHub Action** (`action/`): a workflow step uploads the checked-out tree
   with the CLI, waits, and fails the step if tests fail.

> Verification status: both were tested locally only — the App against a fake
> GitHub API server that verifies the App JWT signature, the Action's script
> by executing `action/run.sh` against a real API server. Neither was run on
> github.com from this environment.

## GitHub App setup

1. Create a GitHub App (Settings → Developer settings → GitHub Apps):
   * Webhook URL: `https://<your-host>/api/v1/webhooks/github`, secret =
     `GITHUB_WEBHOOK_SECRET`;
   * Repository permissions: Contents **read**, Metadata **read**, Checks
     **write**, Commit statuses **write**, Pull requests **write** (reserved
     for comments, not used yet);
   * Events: Push, Pull request, Installation;
   * Optional: enable "Request user authorization (OAuth)" and set the callback
     to `https://<your-host>/api/v1/auth/github/callback` for GitHub login.
2. Configure the API: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM, `\n`
   escaped is accepted), `GITHUB_WEBHOOK_SECRET`, and for login
   `GITHUB_OAUTH_CLIENT_ID`/`GITHUB_OAUTH_CLIENT_SECRET`.
3. Install the App on the repositories you want.
4. In VerifyCloud: log in with GitHub once (links your GitHub login), then
   Organization settings → **Claim installation** with the installation id.
   Only the GitHub user who installed the App can claim it.
5. Project settings → **GitHub repository**: `owner/repo`, installation id,
   default branch.

## What happens on events

| Event | Action |
| --- | --- |
| `installation` created/deleted | installation recorded (with the installing user) / marked removed |
| `push` to the project's branch | job for the pushed commit (`push` regression, else `default`, else first) |
| `pull_request` opened/synchronize/reopened | job for the head commit (`pr` regression, …) if PR checks are enabled |

Then: a queued check run "VerifyCloud regression" and a pending commit status
`verifycloud/regression` are created; on completion the check is updated with
conclusion (`success`/`failure`/…), a summary (pass/fail counts, failing tests
with seeds, coverage and delta) and a link to the run. Deliveries are verified
(HMAC-SHA256 over the raw body) and de-duplicated by `X-GitHub-Delivery`;
GitHub API calls go through an outbox with retries and backoff.

Credentials: the App JWT is minted per use; installation tokens are requested
per operation with `repositories: [<repo>]` (one repository) and the
minimum permissions, never stored, never written to logs; workers receive a
token only to fetch the exact commit, outside the sandbox.

## GitHub Action

```yaml
- uses: actions/checkout@v4
- uses: <owner>/verifycloud/action@<ref>
  with:
    api-url: https://verifycloud.example.com
    token: ${{ secrets.VERIFYCLOUD_TOKEN }}     # org API key (engineer)
    project: my-org/my-ip
    regression: smoke
```

Outputs: `job-id`, `state`, `url`. A step summary with failing tests is
written. The token is passed via environment and masked. The action builds
the CLI from this repository's source (no published npm package).
See `examples/github-actions/verifycloud.yml`.
