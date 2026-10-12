// Fixed costs: sandbox container start+teardown, and the demo build cold vs
// build-cache hit, measured through the platform (real worker, real Docker).
//   npx tsx bench/costs.ts   (writes docs/benchmarks/costs.json)
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { applyFilePatch, parseUnifiedDiff } from "@verifycloud/shared";

import { createTestDatabase, DEMO_DIR, orgWithProject, snapshotOf, startServer, uploadSnapshot } from "../packages/server/test/helpers.js";
import { startWorker } from "../packages/worker/src/main.js";
import { environment, stats } from "./env.js";

const IMAGE = process.env.SIM_IMAGE ?? "verifycloud-sim:verilator";
const N_START = Number(process.env.BENCH_STARTS ?? 20);
const N_BUILD = Number(process.env.BENCH_BUILDS ?? 5);

// 1. container start + teardown with the sandbox's isolation flags
const startSec: number[] = [];
for (let i = 0; i < N_START; i++) {
  const t0 = performance.now();
  execFileSync("docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512", "--memory", "512m", "--user", "65534:65534", IMAGE, "true"], { stdio: "ignore" });
  startSec.push((performance.now() - t0) / 1000);
}

// 2. demo build: cold (unique source → cache miss) and cache hit (same source again)
const files: Record<string, string> = {};
const walk = (d: string) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else files[relative(DEMO_DIR, p)] = readFileSync(p, "utf8");
  }
};
walk(DEMO_DIR);
for (const fp of parseUnifiedDiff(files["fix-rdata-stable.patch"]!)) files[fp.newPath!] = applyFilePatch(files[fp.oldPath!] ?? null, fp)!;

async function main() {
  const db = await createTestDatabase();
  const s = await startServer(db.url, { limits: { jobCreatePerMinute: 1000 } } as any);
  const worker = await startWorker({ apiUrl: s.base, name: "costs", sandbox: "docker", simImage: IMAGE, cpus: 2, memoryMb: 6144, pollIntervalMs: 100, workDir: join(tmpdir(), `vc-costs-${process.pid}`) });
  const o = await orgWithProject(s.base, "costs");
  const buildSeconds = async (variant: number) => {
    await uploadSnapshot(o.c, o.project.id, snapshotOf({ ...files, "rtl/axil_regs.sv": files["rtl/axil_regs.sv"] + `\n// variant ${variant}\n` }));
    const job = (await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke", tests: ["smoke"] })).json.job;
    for (;;) {
      const j = (await o.c.get(`/api/v1/jobs/${job.id}`)).json.job;
      if (!["QUEUED", "RUNNING"].includes(j.state)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const b = (await s.db.query("SELECT duration_ms, state FROM tasks WHERE job_id = $1 AND kind = 'build'", [job.id])).rows[0];
    if (b.state !== "PASSED") throw new Error(`build ${b.state}`);
    return Number(b.duration_ms) / 1000;
  };
  const cold: number[] = [];
  const hit: number[] = [];
  for (let i = 0; i < N_BUILD; i++) {
    const v = Date.now() + i;
    cold.push(await buildSeconds(v));
    hit.push(await buildSeconds(v));
  }
  await worker.stop();
  await s.app.close();
  await db.drop();
  const out = { benchmark: "fixed costs", environment: environment(), containerStartTeardownSeconds: stats(startSec), coldBuildSeconds: stats(cold), cacheHitBuildSeconds: stats(hit), raw: { startSec, cold, hit } };
  writeFileSync(process.env.BENCH_OUT ?? "docs/benchmarks/costs.json", JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify({ start: out.containerStartTeardownSeconds, cold: out.coldBuildSeconds, hit: out.cacheHitBuildSeconds }));
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
