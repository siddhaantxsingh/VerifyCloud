// Audit log: who did what to which resource, from where. Written in the same
// transaction as the change when the caller passes its transaction client.
import type { FastifyRequest } from "fastify";

import type { Principal } from "./access.js";
import type { Q } from "./db.js";

export interface AuditEntry {
  orgId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

export async function audit(q: Q, req: FastifyRequest | null, actor: Principal | { label: string } | null, e: AuditEntry) {
  const p = actor && "kind" in actor ? actor : null;
  await q.query(
    `INSERT INTO audit_events (org_id, actor_user_id, actor_token_id, actor_label, action, target_type, target_id, ip, request_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      e.orgId,
      p?.kind === "user" ? p.userId : null,
      p ? (p.kind === "org_key" ? p.tokenId : (p.tokenId ?? null)) : null,
      actor?.label ?? "system",
      e.action,
      e.targetType ?? null,
      e.targetId ?? null,
      req?.ip ?? null,
      req?.id ?? null,
      JSON.stringify(e.metadata ?? {}),
    ],
  );
}
