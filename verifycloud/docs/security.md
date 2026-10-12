# Security

This page summarizes the controls; the threat model is in
[threat-model.md](threat-model.md) and the sandbox in
[worker-security.md](worker-security.md). The findings of the 2026-10
security audit, and what was and was not verified, are in
[audit-2026-10-08/security-report.md](audit-2026-10-08/security-report.md).

Changes from that audit, in short:
* Org API keys are capped by their creator's current role.
* Member management requires a user, not a key.
* Read-only tokens cannot write.
* OAuth `state` is bound to a cookie.
* `TRUST_PROXY` takes a hop count or CIDR list.
* The SSRF guard has separate v4/v6 lists, which also fixes webhooks to public IPv4.
* `/metrics` needs a token in production.
* Upload memory is bounded.
* Prompt-injection delimiters carry a nonce, and AI patches are scope-limited.
* Redaction covers more formats.

## Identity and access

* **Users**: email + password (scrypt N=2^15, r=8, p=1, per-user salt),
  optional email verification, optional GitHub OAuth login (state parameter
  bound to the browser, single use). Sessions are random 256-bit tokens in an
  `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production), stored hashed.
* **Tokens**: personal access tokens (`vc_pat_…`) and organization API keys
  (`vc_key_…`) with scopes `read`/`write`/`admin`, expiry, last-used time,
  revocation; stored as SHA-256 hashes; shown once. Tokens cannot create
  tokens.
* **Workers**: per-worker tokens (`vc_wrk_…`) issued at registration with the
  shared registration secret; per-task lease tokens on every call.
* **RBAC** per organization: `owner` (everything incl. owners), `admin`
  (projects, members, keys, settings), `engineer` (run, cancel, analyze,
  patches), `viewer` (read). Effective permission = role ∩ token scopes.
* **Tenant isolation**: every resource is loaded through helpers that join on
  the caller's memberships; resources of other organizations answer **404**
  (not 403) so IDs cannot be probed. Tested for jobs, tasks, artifacts,
  analyses, patches, projects, waveforms, SSE streams.

## Web

* CSRF: cookie-authenticated state changes require an `Origin` that is the
  public URL or in `ALLOWED_ORIGINS`; bearer-token requests are not subject to
  it.
* Headers: CSP (`default-src 'self'`, no inline scripts, `frame-ancestors
  'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on API responses.
* Artifact downloads are served as attachments (`Content-Disposition:
  attachment`), never rendered inline from the API origin.
* Rate limits: registration per IP, login per IP **and** per account (`AUTH_RATE_PER_MINUTE`), API per
  principal (`API_RATE_PER_MINUTE`), job creation per organization
  (`JOB_CREATE_PER_MINUTE`), demo sessions per IP.

## Data

* Project secrets: AES-256-GCM with a server key (`SECRET_ENCRYPTION_KEY`),
  random nonce per value, never returned by the API, never given to
  sandboxes, redacted from logs and AI context.
* Webhook signing secrets: encrypted the same way; outgoing webhooks carry
  `X-VerifyCloud-Signature-256: sha256=<HMAC of the body>`.
* GitHub: App private key only in the API's environment; installation tokens
  are requested per use, scoped to one repository, never stored, never
  logged. Incoming webhooks: HMAC-SHA256 over the raw body with a
  constant-time compare; deliveries de-duplicated by `X-GitHub-Delivery`.
  An installation can only be claimed by the GitHub user who installed it.
* Outgoing HTTP to user-supplied URLs (webhooks): `https` only (unless
  explicitly allowed for development), no credentials in URLs, private,
  loopback, link-local and reserved addresses refused both at validation time
  and at connection time (DNS rebinding), redirects not followed.
* Uploads: size limits; snapshot archives are inspected before acceptance
  (regular files only, no absolute paths, no `..`, no links, file-count and
  unpacked-size limits).
* Patches: parsed strictly; may only modify files that exist in the job's
  sources; applied to a fresh copy; never pushed or merged.
* Logs: structured; tokens, secrets and `Authorization` headers are redacted;
  request ids in every error response.
* Audit log: authentication-relevant and administrative actions (tokens, keys,
  members, roles, projects, secrets, repository connections, runs, patches,
  AI analyses) with actor, IP and request id.

## Supply chain

`npm audit --omit=dev` reported 0 vulnerabilities at the time of writing
(vitest and nodemailer were upgraded during development to clear advisories).
Container images use Ubuntu 24.04 and official Node 22 bases; the simulator
image contains only Verilator, GCC and make.

## Reporting

Report vulnerabilities privately to the maintainers; do not open public issues
for them.
