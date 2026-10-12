// API server entry point with bounded graceful shutdown.
import { createApp } from "./app.js";
import { seedDemo } from "./seed.js";

const app = await createApp();
if (process.env.DEMO_SEED === "true") {
  const r = await seedDemo(app.ctx, {
    examplesDir: process.env.DEMO_EXAMPLE_DIR ?? "examples/axi4lite-demo",
    adminEmail: process.env.DEMO_ADMIN_EMAIL || undefined,
    adminPassword: process.env.DEMO_ADMIN_PASSWORD || undefined,
  });
  app.ctx.log.info(r, "demo seed");
}
const port = await app.listen();
app.ctx.log.info({ port, publicDemo: app.ctx.cfg.publicDemo }, "VerifyCloud API listening");

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    app.ctx.log.info({ signal: sig }, "shutting down");
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
