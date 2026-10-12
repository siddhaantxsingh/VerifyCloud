// PostgreSQL access: pool, transactions, forward-only migrations.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

export type Db = pg.Pool;
export type Q = Pick<pg.Pool, "query"> | pg.PoolClient;

export function createPool(url: string, onError: (e: Error) => void): Db {
  const pool = new pg.Pool({ connectionString: url, max: 20, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  pool.on("error", onError); // idle client errors (e.g. database restart) must not crash the process
  // A checked-out client has no pool listener; without its own, a server
  // restart between queries would surface as an uncaught 'error' event.
  pool.on("connect", (client) => client.on("error", onError));
  return pool;
}

export async function tx<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const migrationsDir = () => {
  // works from src/ (tsx) and dist/ (compiled; migrations copied by the build)
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "migrations");
};

/** Apply pending migrations in order, one transaction each, under an advisory lock (safe with several API replicas). */
export async function migrate(db: Db): Promise<number[]> {
  const c = await db.connect();
  const applied: number[] = [];
  try {
    await c.query("SELECT pg_advisory_lock(7471001)");
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await c.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version as number));
    const files = readdirSync(migrationsDir()).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    for (const f of files) {
      const version = Number(f.slice(0, 3));
      if (done.has(version)) continue;
      await c.query("BEGIN");
      try {
        await c.query(readFileSync(join(migrationsDir(), f), "utf8"));
        await c.query("INSERT INTO schema_migrations(version, name) VALUES ($1, $2)", [version, f]);
        await c.query("COMMIT");
        applied.push(version);
      } catch (e) {
        await c.query("ROLLBACK");
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(7471001)").catch(() => {});
    c.release();
  }
  return applied;
}
