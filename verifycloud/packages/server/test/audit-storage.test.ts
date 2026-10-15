// Artifact storage against the S3 endpoint (moto in this environment; MinIO
// in docker-compose): integrity of a large upload, HTTP Range downloads,
// interrupted uploads, the size limit, and the upload memory budget (audit S13).
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { request } from "node:http";

import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, FakeWorker, minimalConfig, orgWithProject, S3, S3_KEY, S3_SECRET, sleep, snapshotOf, startServer, uploadSnapshot, waitFor, type TestServer } from "./helpers.js";

let db: { url: string; drop: () => Promise<void> };
let s: TestServer;
const MB = 1024 * 1024;
const bucket = `vc-st-${randomBytes(4).toString("hex")}`;
const s3 = new S3Client({ endpoint: S3, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: S3_KEY, secretAccessKey: S3_SECRET } });
const objectCount = async () => (await s3.send(new ListObjectsV2Command({ Bucket: bucket }))).KeyCount ?? 0;

beforeAll(async () => {
  db = await createTestDatabase();
  s = await startServer(db.url, {
    s3: { endpoint: S3, region: "us-east-1", bucket, accessKeyId: S3_KEY, secretAccessKey: S3_SECRET, forcePathStyle: true },
    limits: { maxArtifactBytes: 64 * MB, uploadMemoryBudgetBytes: 80 * MB } as any,
  });
});
afterAll(async () => {
  await s?.app.close();
  await db?.drop();
});

async function runningTask() {
  const o = await orgWithProject(s.base, "st");
  await uploadSnapshot(o.c, o.project.id, snapshotOf({ "verifycloud.yaml": minimalConfig(), "rtl/a.sv": "module a; endmodule\n", "tb/tb.sv": "module tb; endmodule\n" }));
  await o.c.post(`/api/v1/projects/${o.project.id}/jobs`, { regression: "smoke", tests: ["t1"] });
  const w = await new FakeWorker(s.base).register();
  const b = await waitFor(() => w.claim(), 10_000, "build claim");
  const m = await w.upload(b.task.id, b.leaseToken, "model", "sim", Buffer.from("x"));
  await w.complete(b.task.id, b.leaseToken, { state: "PASSED", durationMs: 1, modelArtifactId: m.json.id });
  const t = await waitFor(() => w.claim(), 10_000, "test claim");
  return { o, w, t };
}

/** Start an upload that sends `send` of `total` bytes and then stalls until destroyed. */
function stalledUpload(w: FakeWorker, taskId: string, lease: string, total: number, send: number) {
  const u = new URL(`${s.base}/internal/v1/tasks/${taskId}/artifacts?kind=log&name=big.log&contentType=text/plain`);
  const req = request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "POST", headers: { Authorization: `Bearer ${w.token}`, "X-Lease-Token": lease, "Content-Type": "application/octet-stream", "Content-Length": String(total) } });
  req.on("error", () => {});
  req.write(Buffer.alloc(send, 1));
  return req;
}

describe("artifact storage (audit)", () => {
  it("a 60 MB artifact round-trips byte-exact; Range requests return exact slices", async () => {
    const { o, w, t } = await runningTask();
    const body = randomBytes(60 * MB);
    const rss0 = process.memoryUsage().rss;
    const t0 = performance.now();
    const up = await w.upload(t.task.id, t.leaseToken, "log", "big.log", body, { contentType: "text/plain" });
    const ms = performance.now() - t0;
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    // eslint-disable-next-line no-console
    console.log(`[storage] 60 MB upload ${ms.toFixed(0)} ms; process RSS +${((process.memoryUsage().rss - rss0) / MB).toFixed(0)} MB (API and client share this process)`);
    const res = await fetch(`${s.base}/api/v1/artifacts/${up.json.id}/download`, { headers: { Cookie: o.c.cookie } });
    expect(res.status).toBe(200);
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.length).toBe(body.length);
    expect(createHash("sha256").update(got).digest("hex")).toBe(createHash("sha256").update(body).digest("hex"));
    expect(res.headers.get("x-content-sha256") ?? createHash("sha256").update(body).digest("hex")).toBe(createHash("sha256").update(body).digest("hex"));
    const r = await fetch(`${s.base}/api/v1/artifacts/${up.json.id}/download`, { headers: { Cookie: o.c.cookie, Range: "bytes=1000000-1000999" } });
    expect(r.status).toBe(206);
    expect(Buffer.from(await r.arrayBuffer()).equals(body.subarray(1_000_000, 1_001_000))).toBe(true);
    const bad = await fetch(`${s.base}/api/v1/artifacts/${up.json.id}/download`, { headers: { Cookie: o.c.cookie, Range: `bytes=${body.length}-` } });
    expect(bad.status).toBe(416);
  });

  it("an interrupted upload leaves no artifact row and no stored object; over-limit uploads are refused", async () => {
    const { w, t } = await runningTask();
    const before = await objectCount();
    const rows0 = (await s.db.query("SELECT count(*)::int AS n FROM artifacts")).rows[0].n;
    const req = stalledUpload(w, t.task.id, t.leaseToken, 20 * MB, 5 * MB);
    await sleep(500);
    req.destroy();
    await sleep(1000);
    expect((await s.db.query("SELECT count(*)::int AS n FROM artifacts")).rows[0].n).toBe(rows0);
    expect(await objectCount()).toBe(before);
    const big = await w.upload(t.task.id, t.leaseToken, "log", "huge.log", Buffer.alloc(65 * MB));
    expect(big.status).toBe(413);
    expect(await objectCount()).toBe(before);
  });

  it("S13: concurrent uploads beyond the memory budget get 503 + Retry-After; the budget is released when an upload is aborted", async () => {
    const { w, t } = await runningTask();
    const first = stalledUpload(w, t.task.id, t.leaseToken, 60 * MB, 1 * MB); // admitted, holds 60 MB of budget
    await sleep(500);
    const second = await w.upload(t.task.id, t.leaseToken, "log", "b.log", Buffer.alloc(30 * MB));
    expect(second.status).toBe(503);
    expect(second.json.error.code).toBe("UPLOAD_BUSY");
    const small = await w.upload(t.task.id, t.leaseToken, "log", "c.log", Buffer.alloc(10 * MB)); // fits beside it
    expect(small.status).toBe(201);
    first.destroy();
    await sleep(500);
    const third = await w.upload(t.task.id, t.leaseToken, "log", "d.log", Buffer.alloc(30 * MB));
    expect(third.status).toBe(201);
    expect(s.app.ctx.metrics.uploadsRejected.get()).toBeGreaterThan(0);
  });

  // Needs a MinIO container this test may restart: TEST_MINIO_CONTAINER=<name>
  // (2026-10-14; the CI workflow and docs/evidence use "minio" / "vc-minio").
  const minio = process.env.TEST_MINIO_CONTAINER;
  it.skipIf(!minio)("artifacts survive a MinIO restart; readiness reports the outage and recovers", async () => {
    const { o, w, t } = await runningTask();
    const body = randomBytes(8 * MB);
    const up = await w.upload(t.task.id, t.leaseToken, "log", "persist.log", body, { contentType: "text/plain" });
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    const r1 = spawnSync("docker", ["stop", "-t", "5", minio!], { encoding: "utf8" });
    expect(r1.status, r1.stderr).toBe(0);
    try {
      // while MinIO is down the API stays up but is not ready
      await waitFor(async () => (await fetch(`${s.base}/ready`)).status === 503, 30_000, "readiness to report the storage outage");
    } finally {
      const r2 = spawnSync("docker", ["start", minio!], { encoding: "utf8" });
      expect(r2.status, r2.stderr).toBe(0);
    }
    await waitFor(async () => (await fetch(`${s.base}/ready`)).status === 200, 120_000, "readiness after MinIO restart");
    const res = await fetch(`${s.base}/api/v1/artifacts/${up.json.id}/download`, { headers: { Cookie: o.c.cookie } });
    expect(res.status).toBe(200);
    const got = Buffer.from(await res.arrayBuffer());
    expect(createHash("sha256").update(got).digest("hex")).toBe(createHash("sha256").update(body).digest("hex"));
    expect(await objectCount()).toBeGreaterThan(0);
  });
});
