# D. Security report

Status words: **Verified** (an automated test exercises the control against the
real implementation and passed on the final code), **Reviewed** (code
inspection only), **Unverified** (not exercised in this environment).

## 1. Trust boundaries

| Boundary | Untrusted side | Control |
| --- | --- | --- |
| Browser/API client → API | every request | sessions/PATs/org keys, RBAC, CSRF origin check, rate limits |
| Tenant A ↔ tenant B | other organizations | org-scoped queries (`loadOwned`), 404 for foreign ids |
| Repository content → worker | RTL, testbench, config, file names | config schema + flag deny-list; sandbox container; untrusted-output reader |
| Simulation process → worker host | anything the testbench does | Docker container: `--network none`, read-only root and sources, all caps dropped, `no-new-privileges`, non-root, PID/memory/CPU/file-size limits, wall-clock timeout |
| Worker → API | workers (semi-trusted; registration token) | worker tokens, lease fencing on every report and upload, upload memory budget |
| Evidence → LLM | logs, sources, file names, commit messages | delimited, nonce-tagged, defanged data blocks; output schema validation; locations verified; patch scope restricted; never auto-applied |
| GitHub → API | webhook payloads | HMAC-SHA256 signature, delivery de-duplication, installation bound to the installing user's immutable id |
| API → outbound webhooks | user-supplied URLs | SSRF guard: resolved addresses checked against v4/v6 block lists, including embedded IPv4 |

**Docker is not a perfect isolation boundary.** The sandbox shares the host
kernel (runc). A kernel or container-runtime vulnerability lets a hostile
testbench escape onto the worker host. The worker host holds a worker token
and access to the Docker socket. It holds no database or storage
credentials. Mitigations, in order: dedicated worker hosts or VMs per
trust level; gVisor (`runsc`, selectable via the worker's runtime setting —
**Unverified**: not installed here); up-to-date kernels. Per rule 14 of the
audit brief, no kernel/runtime escape attempts were made on this shared host.

## 2. Findings fixed in this audit

See [engineering-audit.md](engineering-audit.md) for root causes and commits.

| ID | Sev | Issue | Status |
| --- | --- | --- | --- |
| C1 | Critical | symlink in the output dir → worker uploads host files | fixed; **Verified** (canary test) |
| S1 | Critical | org API keys outlive the creator's role or membership | fixed; **Verified** (3 cases) |
| C2 | High | FIFO in the output dir hangs the worker | fixed; **Verified** |
| H8 | High | simulator flag deny-list bypass (single-dash, `+incdir+`, `-CFLAGS` …) | fixed; **Verified** |
| S2 | High | API keys manage members; admins mint owners | fixed; **Verified** |
| S3 | High | `X-Forwarded-For` spoofing bypasses per-IP limits | fixed; **Verified** |
| S5 | High | read-only tokens can write | fixed; **Verified** |
| S6 | High | SSRF gaps; IPv4 entirely blocked by a v4-mapped v6 entry | fixed; **Verified** |
| S8 | High | OAuth login CSRF (state not bound to the browser) | fixed; **Verified** against a fake GitHub OAuth server |
| S11 | High | installation takeover by renaming a GitHub login | fixed; **Verified** |
| S13 | High | unbounded memory from concurrent artifact uploads | fixed; **Verified** |
| P1 | High | prompt-injection delimiter escape | fixed; **Verified** (unit + API) |
| P2 | High | AI patch can delete the failing assertion or change the config | fixed; **Verified** |
| G1 | High | webhook lost after a processing failure | fixed; **Verified** |
| W1 | Medium | git credential in `argv`; unvalidated sha/URL | fixed; **Reviewed** + unit |
| S4 | Medium | `/metrics` without token in production | fixed; **Verified** |
| S12 | Medium | open redirect via `?next=` | fixed; **Verified** |
| S7, S10, S9, S2b, P3 | Medium/Low | missing rate limits, limiter reset, error leakage, last-owner race, redaction gaps | fixed; Verified or Reviewed (see audit) |

## 3. Controls verified on the final code

Each item points to the test that exercises it:

- Tenant isolation: security.test.ts "user A cannot read, modify or even detect…" and "an organization API key never reaches another organization".
- RBAC order, token scopes, revoked/expired/forged credentials, hashed storage, login rate limit, single-use email tokens, CSRF on cookie writes, error shape without stacks, injection payloads as data, secret values never returned: security.test.ts.
- Source archive attacks (traversal, absolute paths, symlinks, bombs): security.test.ts.
- Privilege boundaries of keys and members, OAuth CSRF, trust proxy, SSRF ranges, read-only tokens, metrics token: audit-security.test.ts.
- Worker leases: workers touch only artifacts of their leased task (security.test.ts); stale uploads are refused atomically (audit-scheduler M6).
- Sandbox, with real Docker and the real worker:
  - no network, read-only, no capabilities, non-root, no secrets in the environment, no Docker socket
  - fork bomb and memory limits
  - output flood
  - timeout
  - symlink/FIFO output
  - orphan cleanup

  All in sandbox.test.ts.
- Prompt injection and redaction: audit-ai.test.ts, integrations "AUDIT P1/P2", shared audit-redact.test.ts.

## 4. Prompt injection: what is and is not guaranteed

- **Verified:** untrusted text cannot produce a delimiter that the request's real delimiters use. Injected instructions remain visible as data inside a block.
- **Verified:** model output is parsed against a fixed schema. Cited locations are checked against the job's files; invented ones are marked unverified and confidence is lowered. Patches are restricted (P2) and only ever run in a new sandboxed job; nothing is merged or pushed.
- **Not guaranteed:** that a model *ignores* injected instructions. That depends on the model. No real LLM was available (no API key, rule 8), so model behaviour under injection is **Unverified**. The controls above bound the damage: worst case, a wrong analysis or a rejected or failing patch.

## 5. Not verified (blocked)

- Real GitHub (App, OAuth, checks): no GitHub access or credentials. Tested only against fake GitHub servers that verify App JWTs and HMAC signatures.
- SMTP delivery: tested through the outbox only.
- MinIO and AWS S3: images are unreachable from this network. Storage behaviour was verified against moto (an S3 emulator).
- gVisor runtime; SELinux/AppArmor profiles beyond Docker defaults.
- External penetration test; dependency CVEs beyond `npm audit` (0 reported on 2026-10-08).
