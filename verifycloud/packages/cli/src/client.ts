// HTTP client for the public API (/api/v1). Authentication is a personal
// access token or project API key sent as a Bearer token; the token is never
// printed or logged.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const VERSION = "0.1.0";
export const USER_AGENT = `verifycloud-cli/${VERSION} (node ${process.versions.node})`;

export interface CliConfig {
  apiUrl: string;
  token: string;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string) {
    super(message);
  }
}

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "verifycloud", "config.json");
}

/** Environment (CI) overrides the file written by `verifycloud login`. */
export function loadConfig(): CliConfig | null {
  let file: Partial<CliConfig> = {};
  const p = configPath();
  if (existsSync(p)) {
    try {
      file = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      throw new Error(`cannot parse ${p}; run "verifycloud login" again`);
    }
  }
  const apiUrl = process.env.VERIFYCLOUD_API_URL || file.apiUrl;
  const token = process.env.VERIFYCLOUD_TOKEN || file.token;
  if (!apiUrl || !token) return null;
  return { apiUrl: apiUrl.replace(/\/+$/, ""), token };
}

export function saveConfig(c: CliConfig) {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
}

export class Api {
  constructor(public cfg: CliConfig) {}

  async request(method: string, path: string, opts: { json?: unknown; body?: Buffer; contentType?: string; headers?: Record<string, string>; raw?: boolean; timeoutMs?: number } = {}): Promise<any> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.cfg.token}`, "User-Agent": USER_AGENT, Accept: "application/json", ...(opts.headers ?? {}) };
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.body) {
      headers["Content-Type"] = opts.contentType ?? "application/octet-stream";
      body = new Uint8Array(opts.body);
    }
    const url = this.cfg.apiUrl + "/api/v1" + path;
    // retry only connection failures and 502/503/504, with backoff, for at most ~30 s
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000) });
      } catch (e) {
        if (attempt < 5) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new ApiError(0, "UNREACHABLE", `cannot reach ${this.cfg.apiUrl}: ${(e as Error).message}`);
      }
      if ([502, 503, 504].includes(res.status) && attempt < 5) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (opts.raw && res.ok) return res;
      const text = await res.text();
      let j: any = null;
      try {
        j = text ? JSON.parse(text) : null;
      } catch {
        j = null;
      }
      if (!res.ok) {
        const err = j?.error ?? {};
        throw new ApiError(res.status, err.code ?? `HTTP_${res.status}`, err.message ?? (text.slice(0, 300) || res.statusText), err.requestId);
      }
      return j;
    }
  }
  get = (p: string) => this.request("GET", p);
  post = (p: string, json: unknown = {}, headers?: Record<string, string>) => this.request("POST", p, { json, headers });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
