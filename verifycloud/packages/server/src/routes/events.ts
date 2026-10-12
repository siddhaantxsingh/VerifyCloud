// Server-Sent Events: GET /api/v1/events[?project=…][&job=…]
// Resume with the Last-Event-ID header (or ?lastEventId=). Event ids are
// monotonic, so clients drop duplicates by id. A comment line is sent every
// 15 s so proxies and clients can detect stale connections.
import { Type as T } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";

import { loadJob, loadProject, requirePrincipal } from "../access.js";
import type { Ctx } from "../app.js";

export async function eventRoutes(api: FastifyInstance, ctx: Ctx) {
  const { db, events } = ctx;
  api.get(
    "/events",
    {
      schema: {
        tags: ["events"],
        summary: "Real-time job events (Server-Sent Events)",
        querystring: T.Object({ project: T.Optional(T.String({ format: "uuid" })), job: T.Optional(T.String({ format: "uuid" })), lastEventId: T.Optional(T.Integer({ minimum: 0 })) }),
      },
    },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const q = req.query as { project?: string; job?: string; lastEventId?: number };
      let orgIds: string[];
      if (q.job) orgIds = [(await loadJob(db, p, q.job)).row.org_id];
      else if (q.project) orgIds = [(await loadProject(db, p, q.project)).row.org_id];
      else if (p.kind === "org_key") orgIds = [p.orgId];
      else orgIds = (await db.query("SELECT org_id FROM memberships WHERE user_id = $1", [p.userId])).rows.map((r) => r.org_id);
      const header = req.headers["last-event-id"];
      const last = typeof header === "string" && /^\d+$/.test(header) ? Number(header) : q.lastEventId;

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Request-Id": req.id,
      });
      res.write("retry: 3000\n\n");
      let closed = false;
      const unsubscribe = await events.subscribe(
        {
          orgIds: new Set(orgIds),
          projectId: q.project,
          jobId: q.job,
          send: (e) => {
            if (closed) return;
            res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
          },
        },
        last,
      );
      const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15_000);
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        unsubscribe();
      };
      req.raw.on("close", close);
      res.on("error", close);
    },
  );
}
