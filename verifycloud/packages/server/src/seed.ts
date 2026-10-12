// Demo seed: a demo organization with the synthetic AXI4-Lite project and a
// source snapshot of examples/axi4lite-demo. Idempotent.
//   node dist/seed.js [--admin-email you@example.com --admin-password ...]
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

import { tarFiles, validateConfig } from "@verifycloud/shared";

import type { Ctx } from "./app.js";
import { storeArtifact } from "./artifacts.js";
import { hashPassword, sha256hex } from "./crypto.js";
import { upsertCatalog } from "./scheduler.js";

export function snapshotOfDir(dir: string): Buffer {
  const files: { path: string; content: Buffer }[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e.startsWith(".") || e === "obj_dir" || e === "node_modules") continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else files.push({ path: relative(dir, p).split("\\").join("/"), content: readFileSync(p) });
    }
  };
  walk(dir);
  return gzipSync(tarFiles(files), { level: 9 });
}

export async function seedDemo(ctx: Ctx, opts: { examplesDir: string; adminEmail?: string; adminPassword?: string }) {
  const { db } = ctx;
  let org = (await db.query("SELECT * FROM organizations WHERE slug = 'demo'")).rows[0];
  if (!org) {
    org = (await db.query("INSERT INTO organizations (id, slug, name, plan, is_demo) VALUES ($1,'demo','VerifyCloud Demo','demo', true) RETURNING *", [randomUUID()])).rows[0];
  }
  let project = (await db.query("SELECT * FROM projects WHERE org_id = $1 AND slug = 'axi4lite-demo'", [org.id])).rows[0];
  if (!project)
    project = (
      await db.query(
        "INSERT INTO projects (id, org_id, slug, name, description, retention) VALUES ($1,$2,'axi4lite-demo','AXI4-Lite demo','Synthetic AXI4-Lite register block with one intentional bug (see examples/axi4lite-demo/README.md).', '{\"logs\":1,\"waveforms\":1,\"coverage\":1,\"models\":1,\"sources\":1}') RETURNING *",
        [randomUUID(), org.id],
      )
    ).rows[0];
  const gz = snapshotOfDir(opts.examplesDir);
  const sha = sha256hex(gz);
  const existing = (await db.query("SELECT s.id FROM source_snapshots s JOIN artifacts a ON a.id = s.artifact_id WHERE s.project_id = $1 AND s.sha256 = $2", [project.id, sha])).rows[0];
  let snapshotId = existing?.id;
  if (!snapshotId) {
    const configText = readFileSync(join(opts.examplesDir, "verifycloud.yaml"), "utf8");
    const v = validateConfig(configText);
    if (!v.ok) throw new Error("demo configuration is invalid: " + JSON.stringify(v.issues));
    const art = await storeArtifact(ctx, { orgId: org.id, projectId: project.id, jobId: null, taskId: null, kind: "source", name: "source.tar.gz", contentType: "application/gzip", body: gz });
    // demo snapshots never expire
    await db.query("UPDATE artifacts SET expires_at = NULL WHERE id = $1", [art.id]);
    await upsertCatalog(db, project.id, v.config);
    snapshotId = randomUUID();
    await db.query("INSERT INTO source_snapshots (id, org_id, project_id, artifact_id, sha256, file_count, config_text) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
      snapshotId, org.id, project.id, art.id, sha, 0, configText,
    ]);
  }
  let adminId: string | null = null;
  if (opts.adminEmail && opts.adminPassword) {
    const u = (await db.query("SELECT id FROM users WHERE email = $1", [opts.adminEmail.toLowerCase()])).rows[0];
    adminId = u?.id ?? randomUUID();
    if (!u)
      await db.query("INSERT INTO users (id, email, name, password_hash, email_verified_at) VALUES ($1,$2,'Demo admin',$3, now())", [adminId, opts.adminEmail.toLowerCase(), await hashPassword(opts.adminPassword)]);
    await db.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING", [org.id, adminId]);
  }
  return { orgId: org.id, projectId: project.id, snapshotId, adminId };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { createApp } = await import("./app.js");
  const app = await createApp({}, { background: false });
  const arg = (n: string) => {
    const i = process.argv.indexOf(n);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const r = await seedDemo(app.ctx, { examplesDir: arg("--dir") ?? process.env.DEMO_EXAMPLE_DIR ?? "examples/axi4lite-demo", adminEmail: arg("--admin-email"), adminPassword: arg("--admin-password") });
  console.log(JSON.stringify(r));
  await app.close();
}
