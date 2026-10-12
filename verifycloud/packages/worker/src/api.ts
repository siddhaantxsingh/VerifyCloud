// Client for the internal worker API. All task calls carry the lease token.
import type { WorkerConfig } from "./config.js";

export class TransientError extends Error {}

export class LeaseLostError extends Error {}

/** The API marked this worker offline (e.g. after an outage); it must register again. */
export class ReregisterError extends Error {}

export interface ClaimedTask {
  task: { id: string; kind: "build" | "test"; attempt: number; testName: string | null; seed: number | null; plusargs: Record<string, string>; cpu: number; memoryMb: number; timeoutSeconds: number; modelArtifactId: string | null };
  leaseToken: string;
  leaseSeconds: number;
  job: { id: string; orgId: string; projectId: string; number: number; regression: string; config: any; source: any; patch: string | null; commitSha: string | null };
}

export class WorkerApi {
  token = "";
  workerId = "";
  constructor(private cfg: WorkerConfig) {}

  /**
   * Requests that must survive a short API outage (restart, deploy, network
   * blip) are retried with exponential backoff on connection errors and
   * 502/503/504. Lease, auth and validation errors are never retried.
   * Server-side, completion is idempotent per lease token and uploads are
   * bounded by the lease, so a retry cannot double-apply a result.
   */
  private async req(method: string, path: string, opts: { body?: unknown; raw?: Buffer; lease?: string; query?: Record<string, string>; timeoutMs?: number; retryForMs?: number; retryOn5xx?: boolean } = {}) {
    const deadline = Date.now() + (opts.retryForMs ?? 0);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(method, path, opts);
      } catch (e) {
        if (!(e instanceof TransientError) || Date.now() >= deadline) throw e;
        await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 5000)));
      }
    }
  }

  private async once(method: string, path: string, opts: { body?: unknown; raw?: Buffer; lease?: string; query?: Record<string, string>; timeoutMs?: number; retryOn5xx?: boolean }) {
    const u = new URL(this.cfg.apiUrl + "/internal/v1" + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) u.searchParams.set(k, v);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (opts.lease) headers["X-Lease-Token"] = opts.lease;
    let body: BodyInit | undefined;
    if (opts.raw) {
      headers["Content-Type"] = "application/octet-stream";
      body = new Uint8Array(opts.raw);
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    let res: Response;
    try {
      res = await fetch(u, { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000) });
    } catch (e) {
      throw new TransientError(`${method} ${path}: ${(e as Error).message}`);
    }
    if ([502, 503, 504].includes(res.status)) throw new TransientError(`${method} ${path} → HTTP ${res.status}`);
    // a completion that hit a server error (e.g. a lock conflict) is retried
    // with the SAME report: completion is idempotent per lease, and replacing
    // a real result with "ERROR" would discard it (audit H3)
    if (res.status >= 500 && opts.retryOn5xx) throw new TransientError(`${method} ${path} → HTTP ${res.status}`);
    if (res.status === 409) {
      const e = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
      if (e.error?.code === "LEASE_LOST") throw new LeaseLostError("lease lost");
    }
    if (res.status === 401) {
      const e = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
      if (e.error?.code === "WORKER_REREGISTER") throw new ReregisterError("worker marked offline; re-registering");
      throw new Error("worker token rejected");
    }
    if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res;
  }

  async register(info: { sandbox: string; toolchain: Record<string, unknown>; version: string }) {
    const res = await fetch(this.cfg.apiUrl + "/internal/v1/workers/register", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.registrationToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: this.cfg.name, version: info.version, sandbox: info.sandbox, cpus: this.cfg.cpus, memoryMb: this.cfg.memoryMb, toolchain: info.toolchain }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`worker registration failed: HTTP ${res.status} ${await res.text()}`);
    const r = (await res.json()) as { workerId: string; token: string; leaseSeconds: number };
    this.token = r.token;
    this.workerId = r.workerId;
    return r;
  }

  async heartbeatWorker(running: number, draining = false) {
    await this.req("POST", "/workers/heartbeat", { body: { running, draining }, timeoutMs: 10_000 });
  }

  async claim(free: { cpu: number; memoryMb: number }): Promise<ClaimedTask | null> {
    const r = (await (await this.req("POST", "/tasks/claim", { body: free, timeoutMs: 30_000 })).json()) as ClaimedTask | { task: null };
    return r.task ? (r as ClaimedTask) : null;
  }

  async heartbeatTask(taskId: string, lease: string): Promise<{ cancel: boolean }> {
    return (await (await this.req("POST", `/tasks/${taskId}/heartbeat`, { lease, timeoutMs: 10_000 })).json()) as { cancel: boolean };
  }

  async gitCredentials(taskId: string, lease: string): Promise<{ cloneUrl: string; sha: string; username: string; token: string }> {
    return (await (await this.req("GET", `/tasks/${taskId}/git-credentials`, { lease, retryForMs: 120_000 })).json()) as any;
  }

  async cacheLookup(taskId: string, lease: string, key: string): Promise<{ hit: boolean; artifactId: string | null }> {
    return (await (await this.req("GET", `/tasks/${taskId}/cache/${key}`, { lease, retryForMs: 120_000 })).json()) as any;
  }

  async download(taskId: string, lease: string, artifactId: string): Promise<Buffer> {
    const res = await this.req("GET", `/tasks/${taskId}/artifacts/${artifactId}`, { lease, timeoutMs: 600_000, retryForMs: 120_000 });
    return Buffer.from(await res.arrayBuffer());
  }

  async upload(taskId: string, lease: string, a: { kind: string; name: string; contentType: string; encoding?: "gzip"; meta?: Record<string, unknown>; body: Buffer }): Promise<string> {
    const query: Record<string, string> = { kind: a.kind, name: a.name, contentType: a.contentType };
    if (a.encoding) query.encoding = a.encoding;
    if (a.meta) query.meta = JSON.stringify(a.meta);
    const r = (await (await this.req("POST", `/tasks/${taskId}/artifacts`, { lease, raw: a.body, query, timeoutMs: 600_000, retryForMs: 120_000 })).json()) as { id: string };
    return r.id;
  }

  async complete(taskId: string, lease: string, report: Record<string, unknown>) {
    return (await (await this.req("POST", `/tasks/${taskId}/complete`, { lease, body: { report }, retryForMs: 180_000, retryOn5xx: true })).json()) as { state: string; requeued: boolean };
  }
}
