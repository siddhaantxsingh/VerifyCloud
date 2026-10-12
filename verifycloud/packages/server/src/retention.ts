// Retention: expired artifacts are deleted (row + object). Deleting a row
// queues its object key in storage_gc (database trigger); this loop deletes
// the objects. If object storage is down, keys stay queued and are retried,
// so storage is eventually cleaned and nothing is orphaned.
import type { Ctx } from "./app.js";

export class Retention {
  constructor(private ctx: Ctx) {}

  async run(batch = 500): Promise<{ expired: number; objectsDeleted: number; objectErrors: number }> {
    const { db, store, metrics } = this.ctx;
    // Models referenced by a build cache entry used recently are kept alive.
    await db.query(
      `UPDATE artifacts a SET expires_at = now() + interval '1 day'
         FROM build_cache b WHERE b.artifact_id = a.id AND b.last_used_at > now() - interval '1 day' AND a.expires_at < now() + interval '1 day'`,
    );
    const expired = await db.query(
      "DELETE FROM artifacts WHERE id IN (SELECT id FROM artifacts WHERE expires_at < now() ORDER BY expires_at LIMIT $1) RETURNING id",
      [batch],
    );
    const keys = (await db.query("SELECT storage_key FROM storage_gc WHERE attempts < 50 ORDER BY queued_at LIMIT $1", [batch])).rows;
    let deleted = 0;
    let errors = 0;
    for (const { storage_key } of keys) {
      try {
        await store.delete(storage_key);
        await db.query("DELETE FROM storage_gc WHERE storage_key = $1", [storage_key]);
        deleted++;
        metrics.retentionDeleted.inc();
      } catch (e) {
        errors++;
        await db.query("UPDATE storage_gc SET attempts = attempts + 1, last_error = $2 WHERE storage_key = $1", [storage_key, (e as Error).message.slice(0, 300)]);
      }
    }
    return { expired: expired.rowCount ?? 0, objectsDeleted: deleted, objectErrors: errors };
  }
}
