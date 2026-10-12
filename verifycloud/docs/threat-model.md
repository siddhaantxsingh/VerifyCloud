# Threat model

Method: assets → actors → entry points → threats (STRIDE) → mitigations →
residual risk. Status reflects what was implemented **and** tested in this
repository.

## Assets

1. Customers' RTL, testbenches and results (confidential IP).
2. Credentials: GitHub App key, installation tokens, project secrets, user
   passwords/sessions/tokens, worker tokens.
3. Shared compute (worker hosts) and storage.
4. Integrity of verification results (a forged "PASS" is harmful).

## Actors

* Anonymous internet users (and public-demo visitors).
* Authenticated users of another organization.
* A malicious member with `viewer`/`engineer` role.
* Malicious HDL/testbench code running in a sandbox.
* A compromised worker host.
* A malicious or compromised LLM provider; prompt injection in sources/logs.
* A network attacker (forged webhooks, SSRF targets).

## Threats and mitigations

| # | Threat | Mitigation | Tested |
| --- | --- | --- | --- |
| T1 | Code in a simulation reads other tenants' data or credentials | container per run, no network, read-only inputs, no secrets in env, no Docker socket, workers hold no DB/S3 credentials | yes (sandbox.test.ts) |
| T2 | Simulation exhausts shared resources (CPU, memory, disk, PIDs, output, time) | cgroup limits, PID limit, size-limited tmpfs, output and out-dir caps, timeouts, plan quotas, fair scheduling | yes |
| T3 | Simulation escapes the container (kernel/runtime bug) | dedicated worker hosts, optional gVisor, rootless Docker guidance | **no** — residual risk |
| T4 | Cross-tenant access via API (IDOR) | membership-joined loaders, 404 for foreign resources, per-org SSE filtering | yes (security.test.ts) |
| T5 | Privilege escalation within an org | role checks per route, token scopes, owners-only owner management, tokens cannot mint tokens | yes |
| T6 | CSRF / clickjacking | Origin check for cookie writes, SameSite cookies, CSP frame-ancestors, X-Frame-Options | yes (CSRF) |
| T7 | Credential theft from logs/DB | hashed tokens/sessions/passwords, encrypted secrets, log redaction, no tokens in clone URLs | yes (token leak tests) |
| T8 | Forged GitHub webhooks / replay | HMAC over raw body, delivery-id de-duplication | yes |
| T9 | Hijacking another org's GitHub installation | claim allowed only for the installing GitHub user; repository must belong to the installation account | yes |
| T10 | SSRF through notification webhooks | https-only, private/reserved address refusal at validation and connect time, no redirects | yes |
| T11 | Malicious archives (zip-slip, links, bombs) | strict tar inspection, limits | yes |
| T12 | Forged results by a stale/compromised worker | lease tokens (fencing), results only for held tasks | partly: stale reports rejected (tested); a fully compromised worker can still report false results for tasks it legitimately holds — residual risk |
| T13 | Private code sent to an LLM | rule-based default, explicit opt-in + `allowExternal`, minimal context, redaction, preview manifest | yes (stub provider) |
| T14 | Prompt injection makes the assistant claim false things | sources/logs passed as delimited untrusted data, output validated against real files, unverifiable locations flagged, patches verified by re-run, never auto-merged | partly (validation tested; model behavior untested) |
| T15 | Account takeover by brute force | rate limits per IP, scrypt | rate limit tested |
| T16 | Public demo abused to run arbitrary code | demo users limited to the seeded project; uploads, new projects and custom patches refused | yes |
| T17 | Denial of service on the API | rate limits, body size limits, pagination caps, bounded queries | partly (no large-scale DoS test) |
| T18 | Supply-chain compromise of dependencies/images | lockfile, `npm audit`, minimal images | audit only |
| T19 | Simulation output tricks the worker (symlink/FIFO named like an output file, huge directory trees) | outputs read with `O_NOFOLLOW` + non-blocking open + regular-file and size checks; bounded directory scan | yes (sandbox.test.ts AUDIT C1/C2) |
| T20 | Prompt injection breaks out of the evidence blocks or steers an AI patch (delete the failing assertion, change the config) | random per-request delimiter ids, `<<<`/`>>>` defanged in data; AI patches only edit shown files, never the failing checker or `verifycloud.yaml` | yes (audit-ai, integrations AUDIT P1/P2) |
| T21 | A worker or many concurrent uploads exhaust API memory | `UPLOAD_MEMORY_BUDGET_BYTES` (503 + Retry-After) | yes (audit-storage S13) |
| T22 | Lost verification after a failed webhook processing (redelivery ignored) | failed/stale deliveries reprocessed; job creation idempotent | yes (integrations AUDIT G1) |

## Residual risks (accepted, documented)

* Container escape on a worker host (T3) compromises that host's in-flight
  workloads; mitigated by host dedication, not eliminated.
* A worker host that is compromised can falsify results of tasks it is
  assigned (T12). Result signing by an attested runtime would be needed to go
  further.
* Side channels between co-located sandboxes (cache timing) are not
  addressed.
* LLM output quality is unmeasured (no provider available to the 2026-10
  audit); the assistant may be wrong even with evidence (it says so). The
  rule-based analyzer was measured on a labeled bug-injection set: 0 wrong
  diagnoses in 28 analyses, but it abstains on most defects
  (docs/benchmarks/ai-eval.json).
* Whether a given model obeys injected instructions is not controllable;
  the controls bound the damage (no execution, patches restricted and only
  run in a fresh sandboxed job).
