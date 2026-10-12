// Real-time events.
//
// Every event is a row in job_events (ids are monotonic) written in the same
// transaction as the state change it describes, plus a NOTIFY. One LISTEN
// connection per API replica fans events out to SSE subscribers. Clients
// resume with Last-Event-ID; ids make duplicates detectable; a dropped
// LISTEN connection is re-established and the gap is replayed from the table.
import type { EventType, JobEvent } from "@verifycloud/shared";
import pg from "pg";

import type { Db, Q } from "./db.js";

export async function emit(q: Q, e: { type: EventType; orgId: string; projectId: string; jobId: string; data?: Record<string, unknown> }) {
  const r = await q.query(
    "INSERT INTO job_events (org_id, project_id, job_id, type, data) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at",
    [e.orgId, e.projectId, e.jobId, e.type, JSON.stringify(e.data ?? {})],
  );
  await q.query("SELECT pg_notify('vc_events', $1)", [String(r.rows[0].id)]);
  return Number(r.rows[0].id);
}

// Event ids come from a sequence at INSERT time, not at COMMIT, so a
// transaction holding id N can commit after N+1 was delivered. Ids skipped
// over are watched as "gaps" for GAP_SECONDS (then assumed rolled back); each
// drain fetches new ids plus the watched gaps. Cost is proportional to new
// events + open gaps. (The first audit fix rescanned a whole recent window on
// every NOTIFY, which cost O(rate x window) and, past 2000 rows in the window,
// stalled delivery of new events: audit M8b.)
const GAP_SECONDS = 120;
const MAX_GAPS = 10_000;
const START_GAP_WINDOW = 1000;
/** Bounded "already seen" set (insertion order = eviction order). */
function remember(set: Set<number>, id: number, max = 20_000) {
  set.add(id);
  if (set.size > max) for (const old of set) { set.delete(old); if (set.size <= max) break; }
}

const rowToEvent = (r: Record<string, any>): JobEvent => ({
  id: Number(r.id),
  type: r.type,
  orgId: r.org_id,
  projectId: r.project_id,
  jobId: r.job_id,
  at: new Date(r.created_at).toISOString(),
  data: r.data,
});

export interface Subscriber {
  orgIds: Set<string>;
  projectId?: string;
  jobId?: string;
  send: (e: JobEvent) => void;
}

export class EventHub {
  private subs = new Set<Subscriber>();
  private client?: pg.Client;
  private lastId = 0;
  private delivered = new Set<number>();
  private gaps = new Map<number, number>(); // id -> first noticed (ms)
  private stopped = false;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(
    private db: Db,
    private url: string,
    private log: { warn: (o: object, m: string) => void; info: (o: object, m: string) => void },
  ) {}

  async start() {
    const r = await this.db.query("SELECT coalesce(max(id), 0) AS id FROM job_events");
    this.lastId = Number(r.rows[0].id);
    // Events committed before this process started are history, not news.
    // Ids missing just below the start point may belong to transactions that
    // have not committed yet: watch them as gaps for a while.
    const recent = await this.db.query("SELECT id FROM job_events WHERE id > $1::bigint - $2::bigint", [this.lastId, START_GAP_WINDOW]);
    const seen = new Set(recent.rows.map((row) => Number(row.id)));
    for (const id of seen) remember(this.delivered, id);
    const now = Date.now();
    for (let id = Math.max(1, this.lastId - START_GAP_WINDOW + 1); id <= this.lastId; id++) if (!seen.has(id)) this.gaps.set(id, now);
    await this.connect();
  }

  private async connect() {
    if (this.stopped) return;
    const c = new pg.Client({ connectionString: this.url });
    c.on("error", (err) => {
      this.log.warn({ err: err.message }, "event listener connection lost; reconnecting");
      this.scheduleReconnect();
    });
    c.on("end", () => this.scheduleReconnect());
    try {
      await c.connect();
      await c.query("LISTEN vc_events");
      c.on("notification", () => void this.drain());
      this.client = c;
      void this.drain(); // replay anything committed while disconnected
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "event listener cannot connect; retrying");
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const old = this.client;
    this.client = undefined;
    if (old) {
      // keep a no-op error listener: a dying connection emits more than one
      // error (e.g. 57P01 then "terminated unexpectedly"); an 'error' event
      // without a listener would crash the API process
      old.removeAllListeners();
      old.on("error", () => {});
      old.end().catch(() => {});
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, 1000);
  }

  private draining = false;
  private again = false;
  /** Fetch events after lastId in order and dispatch them (serialized). */
  private async drain() {
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.again = false;
        const now = Date.now();
        for (const [id, t] of this.gaps) if (now - t > GAP_SECONDS * 1000) this.gaps.delete(id);
        const r = await this.db.query("SELECT * FROM job_events WHERE id > $1 OR id = ANY($2::bigint[]) ORDER BY id LIMIT 2000", [this.lastId, [...this.gaps.keys()]]);
        for (const row of r.rows) {
          const e = rowToEvent(row);
          this.gaps.delete(e.id);
          if (this.delivered.has(e.id)) continue;
          remember(this.delivered, e.id);
          if (e.id > this.lastId) {
            for (let g = Math.max(this.lastId + 1, e.id - MAX_GAPS); g < e.id; g++) if (!this.delivered.has(g)) this.gaps.set(g, now);
            this.lastId = e.id;
          }
          this.dispatch(e);
        }
        if (this.gaps.size > MAX_GAPS) for (const id of this.gaps.keys()) { this.gaps.delete(id); if (this.gaps.size <= MAX_GAPS) break; }
        if (r.rows.length === 2000) this.again = true;
      } while (this.again);
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "event drain failed");
    } finally {
      this.draining = false;
    }
  }

  private dispatch(e: JobEvent) {
    for (const s of this.subs) {
      if (!s.orgIds.has(e.orgId)) continue;
      if (s.projectId && s.projectId !== e.projectId) continue;
      if (s.jobId && s.jobId !== e.jobId) continue;
      s.send(e);
    }
  }

  /** Subscribe, replaying events after `afterId` first (no gap, no duplicates). */
  async subscribe(s: Subscriber, afterId: number | undefined): Promise<() => void> {
    const buffer: JobEvent[] = [];
    let replaying = afterId !== undefined;
    const seen = new Set<number>();
    const deliver = (e: JobEvent) => {
      if (seen.has(e.id)) return;
      remember(seen, e.id, 5000);
      s.send(e);
    };
    const wrapped: Subscriber = {
      ...s,
      send: (e) => {
        if (replaying) buffer.push(e);
        else deliver(e);
      },
    };
    this.subs.add(wrapped);
    if (afterId !== undefined) {
      const conds = ["id > $1", "org_id = ANY($2)"];
      const params: unknown[] = [afterId, [...s.orgIds]];
      if (s.projectId) conds.push(`project_id = $${params.push(s.projectId)}`);
      if (s.jobId) conds.push(`job_id = $${params.push(s.jobId)}`);
      const r = await this.db.query(`SELECT * FROM job_events WHERE ${conds.join(" AND ")} ORDER BY id LIMIT 2000`, params);
      for (const row of r.rows) deliver(rowToEvent(row));
      replaying = false;
      for (const e of buffer) deliver(e);
    }
    return () => this.subs.delete(wrapped);
  }

  get subscriberCount() {
    return this.subs.size;
  }

  async stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const c = this.client;
    this.client = undefined;
    c?.removeAllListeners();
    c?.on("error", () => {});
    await c?.end().catch(() => {});
  }
}
