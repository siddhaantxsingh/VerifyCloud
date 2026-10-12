// Rate limiting.
//  * Fixed windows stored in PostgreSQL for security-sensitive endpoints
//    (login, registration, job creation): shared by all API replicas.
//  * An in-memory token bucket per caller for general API traffic (per replica).
import type { Q } from "./db.js";

export async function fixedWindow(q: Q, key: string, limit: number, windowSeconds: number): Promise<{ ok: boolean; retryAfter: number }> {
  const r = await q.query(
    `INSERT INTO rate_limits (key, window_start, count)
     VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2) * $2), 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count, extract(epoch FROM (window_start + make_interval(secs => $2) - now()))::int AS retry`,
    [key, windowSeconds],
  );
  const row = r.rows[0];
  return { ok: row.count <= limit, retryAfter: Math.max(1, row.retry) };
}

export async function purgeRateLimits(q: Q) {
  await q.query("DELETE FROM rate_limits WHERE window_start < now() - interval '2 hours'");
}

export class TokenBuckets {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private perMinute: number, private burst = perMinute) {}
  take(key: string): boolean {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) this.buckets.set(key, (b = { tokens: this.burst, at: now }));
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 60_000) * this.perMinute);
    b.at = now;
    // keep recently used keys at the end (Map insertion order = LRU order)
    this.buckets.delete(key);
    this.buckets.set(key, b);
    // bound memory under key floods by evicting the least recently used keys;
    // clearing the whole map let a flood reset everyone's limit (audit S3)
    if (this.buckets.size > 100_000) for (const k of this.buckets.keys()) { this.buckets.delete(k); if (this.buckets.size <= 90_000) break; }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
