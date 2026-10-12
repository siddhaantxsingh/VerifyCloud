// The CLI binary (built dist/main.js) against a real API server; tasks are
// executed by a scripted fake worker. Checks commands, exit codes, the
// snapshot contents and that the token never appears in output.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, DEMO_DIR, FakeWorker, orgWithProject, ROOT, startServer, type TestServer } from "../../server/test/helpers.js";
import { parseArgs } from "../src/main.js";
import { snapshotDir } from "../src/snapshot.js";

const BIN = join(ROOT, "packages", "cli", "dist", "main.js");
let db: { url: string; drop: () => Promise<void> };
let s: TestServer;
let owner: Awaited<ReturnType<typeof orgWithProject>>;
let token = "";
let home = "";

beforeAll(async () => {
  db = await createTestDatabase();
  s = await startServer(db.url);
  owner = await orgWithProject(s.base, "cli");
  token = (await owner.c.post("/api/v1/me/tokens", { name: "cli test", scopes: ["read", "write", "admin"] })).json.token;
  home = mkdtempSync(join(tmpdir(), "vc-cli-"));
});
afterAll(async () => {
  await s.app.close();
  await db.drop();
});

function cli(args: string[], opts: { env?: Record<string, string>; stdin?: string; cwd?: string } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], {
      cwd: opts.cwd ?? home,
      env: { PATH: process.env.PATH ?? "", XDG_CONFIG_HOME: join(home, "cfg"), ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    p.stdin.end(opts.stdin ?? "");
    p.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

describe("argument parsing", () => {
  it("handles flags, repeated flags, = syntax and positional args", () => {
    const a = parseArgs(["run", "--test", "a", "--test=b", "--wait", "--dir", "x", "--", "--literal"]);
    expect(a._).toEqual(["run", "--literal"]);
    expect(a.flags.get("test")).toEqual(["a", "b"]);
    expect(a.flags.get("wait")).toEqual(["true"]);
    expect(a.flags.get("dir")).toEqual(["x"]);
    expect(() => parseArgs(["--dir"])).toThrow(/needs a value/);
  });
});

describe("snapshot", () => {
  it("excludes VCS metadata, build outputs, waveforms, ignored paths and symlinks", () => {
    const d = mkdtempSync(join(tmpdir(), "vc-snap-"));
    cpSync(DEMO_DIR, d, { recursive: true });
    mkdirSync(join(d, ".git"));
    writeFileSync(join(d, ".git", "config"), "[core]");
    mkdirSync(join(d, "obj_dir"));
    writeFileSync(join(d, "obj_dir", "Vtb.cpp"), "//");
    writeFileSync(join(d, "dump.vcd"), "$date");
    mkdirSync(join(d, "scratch"));
    writeFileSync(join(d, "scratch", "notes.txt"), "x");
    writeFileSync(join(d, ".verifycloudignore"), "# local\nscratch/\n");
    symlinkSync("/etc/passwd", join(d, "rtl", "passwd.sv"));
    const r = snapshotDir(d);
    expect(r.files).toContain("verifycloud.yaml");
    expect(r.files).toContain("rtl/axil_regs.sv");
    expect(r.files.some((f) => f.startsWith(".git") || f.startsWith("obj_dir") || f.startsWith("scratch") || f.endsWith(".vcd"))).toBe(false);
    expect(r.files).not.toContain("rtl/passwd.sv");
    expect(r.skipped).toEqual(expect.arrayContaining([{ path: "rtl/passwd.sv", reason: "symlink" }]));
    // deterministic: same tree, same bytes
    expect(snapshotDir(d).gz.equals(r.gz)).toBe(true);
    expect(gunzipSync(r.gz).includes(Buffer.from("root:x:0:0"))).toBe(false);
  });
});

describe("verifycloud CLI", () => {
  it("refuses to work without credentials (exit 2) and validates configs locally", async () => {
    const r = await cli(["status", "00000000-0000-0000-0000-000000000000"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/not logged in/);
    const v = await cli(["validate", "--dir", DEMO_DIR]);
    expect(v.code).toBe(0);
    expect(v.out).toMatch(/ok: 6 tests/);
  });

  it("login stores the token with mode 600 and never prints it", async () => {
    const r = await cli(["login", "--api", s.base], { stdin: token + "\n" });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(owner.email);
    expect(r.out + r.err).not.toContain(token);
    const p = join(home, "cfg", "verifycloud", "config.json");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(p, "utf8")).token).toBe(token);
    const bad = await cli(["login", "--api", s.base], { stdin: "not-a-token\n" });
    expect(bad.code).toBe(2);
    const plain = await cli(["login", "--api", "http://verifycloud.example.com"], { stdin: token });
    expect(plain.code).toBe(2);
    expect(plain.err).toMatch(/plain http/);
  });

  it("project list/create, run --wait with a failing test (exit 1), status, logs, coverage, artifacts", async () => {
    const created = await cli(["project", "create", owner.slug, "rtl-core", "--name", "RTL core"]);
    expect(created.code, created.err).toBe(0);
    const list = await cli(["project", "list", owner.slug]);
    expect(list.out).toContain(`${owner.slug}/rtl-core`);

    const worker = await new FakeWorker(s.base).register();
    const stop = { v: false };
    const loop = (async () => {
      while (!stop.v) {
        await worker.drain((t) => (t.testName === "random" && t.seed === 2 ? "FAILED" : "PASSED"));
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
    const run = await cli(["run", "--project", `${owner.slug}/rtl-core`, "--dir", DEMO_DIR, "--regression", "full", "--wait"]);
    stop.v = true;
    await loop;
    expect(run.code, run.err).toBe(1);
    expect(run.out).toMatch(/state\s+FAILED/);
    expect(run.out).toMatch(/FAILED\s+random seed=2/);
    expect(run.out + run.err).not.toContain(token);

    const jobId = /job #\d+ ([0-9a-f-]{36})/.exec(run.out)![1]!;
    const st = await cli(["status", jobId, "--json"]);
    const j = JSON.parse(st.out);
    expect(j.job.state).toBe("FAILED");
    expect(j.job.trigger).toBe("cli");
    expect(j.tasks.filter((t: any) => t.kind === "test")).toHaveLength(13);

    const cov = await cli(["coverage", jobId]);
    expect(cov.code).toBe(0);
    const arts = await cli(["artifacts", jobId]);
    expect(arts.code).toBe(0);
    const model = /^model\s+\S+\s+\S+\s+\S+\s+([0-9a-f-]{36})$/m.exec(arts.out);
    expect(model, arts.out).not.toBeNull();
    const out = join(home, "model.bin");
    const dl = await cli(["artifacts", jobId, "--download", model![1]!, "--out", out]);
    expect(dl.code, dl.err).toBe(0);
    expect(statSync(out).size).toBeGreaterThan(0);

    const failedTask = j.tasks.find((t: any) => t.state === "FAILED");
    const logs = await cli(["logs", failedTask.id]);
    expect(logs.code).toBe(0); // fake worker uploads no log: empty output, still success
  });

  it("environment variables override the stored login (CI) and API errors exit non-zero with a request id", async () => {
    const r = await cli(["status", "00000000-0000-0000-0000-000000000000"], { env: { VERIFYCLOUD_API_URL: s.base, VERIFYCLOUD_TOKEN: token } });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/JOB_NOT_FOUND.*HTTP 404.*request/);
    const bad = await cli(["whoami"], { env: { VERIFYCLOUD_API_URL: s.base, VERIFYCLOUD_TOKEN: "vc_pat_" + "x".repeat(40) } });
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/HTTP 401/);
  });
});

describe("GitHub Action wrapper (action/run.sh, executed locally — not on a GitHub runner)", () => {
  it("runs the regression, writes outputs and a step summary, exits 1 on failing tests, masks the token", async () => {
    const worker = await new FakeWorker(s.base).register();
    const stop = { v: false };
    const loop = (async () => {
      while (!stop.v) {
        await worker.drain((t) => (t.testName === "reset" ? "FAILED" : "PASSED"));
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
    const outFile = join(home, "gh-output");
    const sumFile = join(home, "gh-summary");
    writeFileSync(outFile, "");
    writeFileSync(sumFile, "");
    const r = await new Promise<{ code: number; out: string }>((resolve) => {
      const p = spawn("bash", [join(ROOT, "action", "run.sh")], {
        env: {
          PATH: process.env.PATH ?? "",
          VC_CLI: BIN,
          VC_PROJECT: `${owner.slug}/demo`,
          VC_REGRESSION: "smoke",
          VC_DIR: DEMO_DIR,
          VC_WAIT: "true",
          VERIFYCLOUD_API_URL: s.base,
          VERIFYCLOUD_TOKEN: token,
          GITHUB_OUTPUT: outFile,
          GITHUB_STEP_SUMMARY: sumFile,
          XDG_CONFIG_HOME: join(home, "empty-cfg"),
        },
      });
      let out = "";
      p.stdout.on("data", (b) => (out += b));
      p.stderr.on("data", (b) => (out += b));
      p.on("close", (code) => resolve({ code: code ?? -1, out }));
    });
    stop.v = true;
    await loop;
    expect(r.code, r.out).toBe(1);
    const outputs = readFileSync(outFile, "utf8");
    expect(outputs).toMatch(/^job-id=[0-9a-f-]{36}$/m);
    expect(outputs).toMatch(/^state=FAILED$/m);
    expect(outputs).toMatch(/^url=http.*\/runs\//m);
    expect(readFileSync(sumFile, "utf8")).toMatch(/VerifyCloud: FAILED[\s\S]*`reset`/);
    // the only occurrence of the token is GitHub's mask command
    expect(r.out.split(token).length - 1).toBe(1);
    expect(r.out).toContain(`::add-mask::${token}`);
  });
});

