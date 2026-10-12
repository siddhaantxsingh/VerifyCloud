// Notifications (outbox pattern). Rows are written in the transaction of the
// event that causes them; this loop delivers them with exponential backoff.
// Kinds: email, webhook (HMAC-signed, SSRF-guarded), github_status,
// github_check, github_comment.
import { createHmac } from "node:crypto";

import { fetch as ufetch } from "undici";

import type { Ctx } from "./app.js";
import { decryptSecret } from "./crypto.js";
import type { Q } from "./db.js";
import { guardedAgent, validateTargetUrl } from "./netguard.js";

export const NOTIFICATION_EVENTS = ["regression_failed", "regression_passed", "coverage_dropped", "worker_failure", "quota_exceeded"] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

const MAX_ATTEMPTS = 8;

export class Notifier {
  private agent;
  private allowPrivate = process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS === "true";
  constructor(private ctx: Ctx) {
    this.agent = guardedAgent(this.allowPrivate);
  }

  /** Queue notifications for every enabled channel of the project subscribed to the event. */
  async notifyProject(q: Q, orgId: string, projectId: string, event: NotificationEvent, payload: Record<string, unknown>) {
    await q.query(
      `INSERT INTO notifications (org_id, channel_id, kind, event, payload)
       SELECT org_id, id, kind, $3, $4 FROM notification_channels WHERE project_id = $1 AND org_id = $2 AND enabled AND $3 = ANY(events)`,
      [projectId, orgId, event, JSON.stringify(payload)],
    );
  }

  async enqueue(q: Q, orgId: string, kind: string, event: string, payload: Record<string, unknown>) {
    await q.query("INSERT INTO notifications (org_id, kind, event, payload) VALUES ($1,$2,$3,$4)", [orgId, kind, event, JSON.stringify(payload)]);
  }

  async deliverPending(limit = 20): Promise<number> {
    const { db } = this.ctx;
    const c = await db.connect();
    let n = 0;
    try {
      await c.query("BEGIN");
      const rows = (
        await c.query(
          `SELECT n.*, ch.target, ch.secret_ciphertext, ch.secret_nonce FROM notifications n LEFT JOIN notification_channels ch ON ch.id = n.channel_id
            WHERE n.status = 'pending' AND n.next_attempt_at <= now() ORDER BY n.id LIMIT $1 FOR UPDATE OF n SKIP LOCKED`,
          [limit],
        )
      ).rows;
      for (const r of rows) {
        try {
          await this.deliver(r);
          await c.query("UPDATE notifications SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1", [r.id]);
          this.ctx.metrics.notifications.inc({ kind: r.kind, result: "sent" });
          n++;
        } catch (e) {
          const attempts = r.attempts + 1;
          const failed = attempts >= MAX_ATTEMPTS;
          await c.query(
            "UPDATE notifications SET attempts = $2, status = $3, last_error = $4, next_attempt_at = now() + make_interval(secs => $5) WHERE id = $1",
            [r.id, attempts, failed ? "failed" : "pending", (e as Error).message.slice(0, 500), Math.min(3600, 5 * 2 ** attempts)],
          );
          this.ctx.metrics.notifications.inc({ kind: r.kind, result: failed ? "failed" : "retry" });
        }
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
    return n;
  }

  private async deliver(r: Record<string, any>) {
    const p = r.payload as Record<string, any>;
    const { github, mailer, cfg } = this.ctx;
    switch (r.kind) {
      case "email":
        await mailer.send({ to: r.target, subject: String(p.subject ?? `VerifyCloud: ${r.event}`), text: String(p.text ?? JSON.stringify(p, null, 2)) });
        return;
      case "webhook": {
        const url = validateTargetUrl(r.target, this.allowPrivate);
        const body = JSON.stringify({ event: r.event, deliveredAt: new Date().toISOString(), data: p });
        const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "VerifyCloud-Webhook", "X-VerifyCloud-Event": r.event, "X-VerifyCloud-Delivery": String(r.id) };
        if (r.secret_ciphertext) headers["X-VerifyCloud-Signature-256"] = "sha256=" + createHmac("sha256", decryptSecret(cfg.secretKey, r.secret_ciphertext, r.secret_nonce)).update(body).digest("hex");
        const res = await ufetch(url, { method: "POST", body, headers, dispatcher: this.agent, redirect: "manual", signal: AbortSignal.timeout(10_000) });
        if (res.status < 200 || res.status >= 300) throw new Error(`webhook target answered HTTP ${res.status}`);
        return;
      }
      case "github_status":
        await github.setStatus(p.installationId, p.repo, p.sha, p.state, p.description, p.targetUrl);
        return;
      case "github_check": {
        const existing = p.checkRunId ?? (await this.ctx.db.query("SELECT github_check->>'checkRunId' AS id FROM jobs WHERE id = $1", [p.jobId])).rows[0]?.id ?? null;
        const id = await github.upsertCheckRun(p.installationId, p.repo, p.sha, existing ? Number(existing) : null, p.run);
        await this.ctx.db.query("UPDATE jobs SET github_check = coalesce(github_check, '{}'::jsonb) || jsonb_build_object('checkRunId', $2::bigint) WHERE id = $1", [p.jobId, id]);
        return;
      }
      case "github_comment":
        await github.commentOnPr(p.installationId, p.repo, p.pr, p.body);
        return;
      default:
        throw new Error(`unknown notification kind ${r.kind}`);
    }
  }
}
