// GitHub integration (GitHub App). Least privilege: the app needs
// contents:read, statuses:write, checks:write, pull_requests:write (comments)
// and metadata:read. Installation tokens are short-lived (1 h), requested per
// repository, cached in memory only, and never logged or returned by the API.
import { createHmac, createSign, timingSafeEqual } from "node:crypto";

import type { ServerConfig } from "./config.js";

type Log = { warn: (o: object, m: string) => void; info: (o: object, m: string) => void };

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class GitHub {
  private tokens = new Map<string, { token: string; expires: number }>();
  constructor(
    private cfg: ServerConfig,
    private log: Log,
  ) {}

  get configured() {
    return Boolean(this.cfg.github.appId && this.cfg.github.privateKey && this.cfg.github.webhookSecret);
  }
  get oauthConfigured() {
    return Boolean(this.cfg.github.oauthClientId && this.cfg.github.oauthClientSecret);
  }

  /** Constant-time check of X-Hub-Signature-256 over the raw body. */
  verifySignature(raw: Buffer, header: string | undefined): boolean {
    const secret = this.cfg.github.webhookSecret;
    if (!secret || !header?.startsWith("sha256=")) return false;
    const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(raw).digest("hex"));
    const got = Buffer.from(header);
    return got.length === expected.length && timingSafeEqual(got, expected);
  }

  private appJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: this.cfg.github.appId })}`;
    const sig = createSign("RSA-SHA256").update(unsigned).sign(this.cfg.github.privateKey!).toString("base64url");
    return `${unsigned}.${sig}`;
  }

  private async request(method: string, path: string, auth: string, body?: unknown): Promise<any> {
    const res = await fetch(this.cfg.github.apiUrl + path, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "VerifyCloud",
        Authorization: auth,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new GitHubError(res.status, `GitHub ${method} ${path.replace(/\?.*$/, "")} failed with HTTP ${res.status}`);
    return text ? JSON.parse(text) : null;
  }

  /** Installation access token limited to one repository. */
  async installationToken(installationId: number, repoFullName: string): Promise<string> {
    const key = `${installationId}:${repoFullName}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expires > Date.now() + 5 * 60_000) return cached.token;
    const repo = repoFullName.split("/")[1];
    const r = await this.request("POST", `/app/installations/${installationId}/access_tokens`, `Bearer ${this.appJwt()}`, {
      repositories: [repo],
      permissions: { contents: "read", statuses: "write", checks: "write", pull_requests: "write", metadata: "read" },
    });
    this.tokens.set(key, { token: r.token, expires: Date.parse(r.expires_at) });
    return r.token;
  }

  async getFile(installationId: number, repo: string, path: string, ref: string): Promise<string | null> {
    const token = await this.installationToken(installationId, repo);
    try {
      const r = await this.request("GET", `/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`, `token ${token}`);
      if (r.type !== "file" || r.size > 256 * 1024) return null;
      return Buffer.from(r.content, "base64").toString("utf8");
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    }
  }

  async resolveRef(installationId: number, repo: string, ref: string): Promise<string> {
    const token = await this.installationToken(installationId, repo);
    const r = await this.request("GET", `/repos/${repo}/commits/${encodeURIComponent(ref)}`, `token ${token}`);
    if (typeof r?.sha !== "string" || !/^[0-9a-f]{40}$/.test(r.sha)) throw new GitHubError(502, "GitHub returned no commit SHA");
    return r.sha;
  }

  async setStatus(installationId: number, repo: string, sha: string, state: "pending" | "success" | "failure" | "error", description: string, targetUrl: string) {
    const token = await this.installationToken(installationId, repo);
    return this.request("POST", `/repos/${repo}/statuses/${sha}`, `token ${token}`, {
      state,
      description: description.slice(0, 140),
      target_url: targetUrl,
      context: "verifycloud/regression",
    });
  }

  async upsertCheckRun(
    installationId: number,
    repo: string,
    sha: string,
    existingId: number | null,
    run: { status: "queued" | "in_progress" | "completed"; conclusion?: "success" | "failure" | "cancelled" | "timed_out" | "neutral"; title: string; summary: string; text?: string; detailsUrl: string },
  ): Promise<number> {
    const token = await this.installationToken(installationId, repo);
    const body = {
      name: "VerifyCloud regression",
      head_sha: sha,
      status: run.status,
      conclusion: run.status === "completed" ? run.conclusion : undefined,
      details_url: run.detailsUrl,
      output: { title: run.title.slice(0, 255), summary: run.summary.slice(0, 65000), text: run.text?.slice(0, 65000) },
    };
    const r = existingId
      ? await this.request("PATCH", `/repos/${repo}/check-runs/${existingId}`, `token ${token}`, body)
      : await this.request("POST", `/repos/${repo}/check-runs`, `token ${token}`, body);
    return r.id;
  }

  async commentOnPr(installationId: number, repo: string, pr: number, body: string) {
    const token = await this.installationToken(installationId, repo);
    return this.request("POST", `/repos/${repo}/issues/${pr}/comments`, `token ${token}`, { body: body.slice(0, 65000) });
  }

  // ------------------------------------------------------------ OAuth login
  oauthAuthorizeUrl(state: string, redirectUri: string) {
    const u = new URL(this.cfg.github.oauthUrl + "/login/oauth/authorize");
    u.searchParams.set("client_id", this.cfg.github.oauthClientId!);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("scope", "read:user user:email");
    u.searchParams.set("state", state);
    u.searchParams.set("allow_signup", "false");
    return u.toString();
  }

  async oauthUser(code: string, redirectUri: string): Promise<{ id: number; login: string; name: string; email: string | null }> {
    const res = await fetch(this.cfg.github.oauthUrl + "/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: this.cfg.github.oauthClientId, client_secret: this.cfg.github.oauthClientSecret, code, redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(15_000),
    });
    const tok = (await res.json()) as { access_token?: string };
    if (!tok.access_token) throw new GitHubError(401, "GitHub OAuth code exchange failed");
    const auth = `Bearer ${tok.access_token}`;
    const user = await this.request("GET", "/user", auth);
    const emails = (await this.request("GET", "/user/emails", auth).catch(() => [])) as { email: string; primary: boolean; verified: boolean }[];
    const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
    return { id: user.id, login: user.login, name: user.name ?? user.login, email: primary?.email ?? null };
  }
}
