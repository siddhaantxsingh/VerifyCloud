#!/usr/bin/env node
// verifycloud — command-line client for VerifyCloud.
//
// Exit codes: 0 success / job SUCCEEDED, 1 job FAILED (tests failed), 2 usage
// or configuration error, 3 job TIMED_OUT / RESOURCE_EXCEEDED / CANCELLED /
// ERROR or an API/infrastructure error.
import { createWriteStream, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { validateConfig } from "@verifycloud/shared";

import { Api, ApiError, configPath, loadConfig, saveConfig, sleep, VERSION } from "./client.js";
import { snapshotDir } from "./snapshot.js";

const HELP = `verifycloud ${VERSION} — CI/CD, regression testing and coverage for RTL

Usage: verifycloud <command> [options]

Authentication
  login --api <url> [--token-stdin]     store a personal access token (asked for, or read from stdin)
  whoami                                show the authenticated identity
  logout                                remove the stored credentials

Projects
  project list <org>
  project create <org> <slug> [--name <name>]
  project connect <org/project> <owner/repo> --installation <id> [--branch <name>]
  validate [--dir <path>]               check verifycloud.yaml locally (no upload)

Runs
  run [--project <org/project>] [--dir <path>] [--regression <name>] [--test <name>]...
      [--wait] [--json] [--idempotency-key <key>]
                                        upload the working tree and start a job
  regression run <name> [run options]   same as run --regression <name>
  status <job-id> [--wait] [--json]     job state and per-test results
  logs <task-id> [--grep <text>] [--errors] [--limit <n>]
  coverage <job-id> [--json]
  artifacts <job-id> [--download <artifact-id> --out <file>]

Environment
  VERIFYCLOUD_API_URL, VERIFYCLOUD_TOKEN   override the stored login (CI)
  VERIFYCLOUD_PROJECT                      default for --project
`;

type Args = { _: string[]; flags: Map<string, string[]> };
const BOOL = new Set(["wait", "json", "token-stdin", "errors", "help", "version"]);

export function parseArgs(argv: string[]): Args {
  const a: Args = { _: [], flags: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "--") {
      a._.push(...argv.slice(i + 1));
      break;
    }
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const k = eq > 0 ? t.slice(2, eq) : t.slice(2);
      let v: string;
      if (eq > 0) v = t.slice(eq + 1);
      else if (BOOL.has(k)) v = "true";
      else {
        const n = argv[i + 1];
        if (n === undefined || n.startsWith("--")) throw new UsageError(`--${k} needs a value`);
        v = n;
        i++;
      }
      a.flags.set(k, [...(a.flags.get(k) ?? []), v]);
    } else a._.push(t);
  }
  return a;
}

class UsageError extends Error {}
const flag = (a: Args, k: string) => a.flags.get(k)?.at(-1);
const has = (a: Args, k: string) => a.flags.get(k)?.at(-1) === "true";

function api(): Api {
  const cfg = loadConfig();
  if (!cfg) throw new UsageError(`not logged in: run "verifycloud login --api <url>" or set VERIFYCLOUD_API_URL and VERIFYCLOUD_TOKEN`);
  return new Api(cfg);
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  process.stderr.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  let s = "";
  return new Promise((res, rej) => {
    const on = (b: Buffer) => {
      for (const ch of b.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", on);
          process.stderr.write("\n");
          return res(s.trim());
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          return rej(new UsageError("cancelled"));
        }
        if (ch === "\u007f") s = s.slice(0, -1);
        else s += ch;
      }
    };
    stdin.on("data", on);
  });
}

async function resolveProject(a: Api, ref: string | undefined): Promise<{ id: string; org: string; slug: string }> {
  const r = ref ?? process.env.VERIFYCLOUD_PROJECT;
  if (!r) throw new UsageError("which project? pass --project <org/project> or set VERIFYCLOUD_PROJECT");
  if (/^[0-9a-f-]{36}$/i.test(r)) {
    const p = (await a.get(`/projects/${r}`)).project;
    return { id: p.id, org: p.org_slug ?? "", slug: p.slug };
  }
  const m = /^([a-z0-9-]+)\/([a-z0-9-]+)$/i.exec(r);
  if (!m) throw new UsageError(`project must be <org>/<project> or a project id, got "${r}"`);
  const list = (await a.get(`/orgs/${m[1]}/projects`)).projects as { id: string; slug: string }[];
  const p = list.find((x) => x.slug === m[2]);
  if (!p) throw new UsageError(`project ${r} not found (or you have no access)`);
  return { id: p.id, org: m[1]!, slug: m[2]! };
}

const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "RESOURCE_EXCEEDED", "ERROR"];
const exitFor = (state: string) => (state === "SUCCEEDED" ? 0 : state === "FAILED" ? 1 : 3);

async function waitJob(a: Api, id: string, quiet: boolean): Promise<any> {
  let last = "";
  for (;;) {
    const j = (await a.get(`/jobs/${id}`)).job;
    const s = j.summary ?? {};
    const line = `${j.state}  passed ${s.passed ?? 0}  failed ${s.failed ?? 0}  running ${s.running ?? 0}  queued ${s.queued ?? 0}`;
    if (!quiet && line !== last) process.stderr.write(`  ${new Date().toISOString().slice(11, 19)}  ${line}\n`);
    last = line;
    if (TERMINAL.includes(j.state)) return j;
    await sleep(2000);
  }
}

async function printJob(a: Api, id: string, json: boolean) {
  const j = (await a.get(`/jobs/${id}`)).job;
  const tasks = (await a.get(`/jobs/${id}/tasks`)).tasks as any[];
  if (json) return void console.log(JSON.stringify({ job: j, tasks }, null, 2));
  console.log(`job #${j.number} ${j.id}`);
  console.log(`state       ${j.state}${j.error ? ` — ${j.error}` : ""}`);
  console.log(`regression  ${j.regression}   trigger ${j.trigger}${j.commit_sha ? `   commit ${String(j.commit_sha).slice(0, 12)}` : ""}`);
  if (j.coverage && Object.keys(j.coverage).length) console.log(`coverage    ${fmtCov(j.coverage)}`);
  console.log("");
  for (const t of tasks) {
    const name = t.kind === "build" ? "build" : `${t.test_name} seed=${t.seed}`;
    const dur = t.duration_ms != null ? `${(t.duration_ms / 1000).toFixed(1)}s` : "";
    console.log(`  ${pad(t.state, 18)} ${pad(name, 32)} ${pad(dur, 8)} ${t.id}${t.summary ? `\n  ${" ".repeat(18)} ${String(t.summary).split("\n")[0]}` : ""}`);
  }
  return j;
}

const pad = (s: string, n: number) => (s.length >= n ? s + " " : s + " ".repeat(n - s.length));
function fmtCov(c: Record<string, any>) {
  return Object.entries(c)
    .filter(([, v]) => v && typeof v === "object" && "total" in v)
    .map(([k, v]: [string, any]) => `${k} ${v.covered}/${v.total}${v.total ? ` (${((100 * v.covered) / v.total).toFixed(1)}%)` : ""}`)
    .join("   ");
}

async function cmdRun(a: Args, regressionArg?: string): Promise<number> {
  const client = api();
  const dir = resolve(flag(a, "dir") ?? ".");
  const local = validateConfig(readFileSync(resolve(dir, "verifycloud.yaml"), "utf8"));
  if (!local.ok) {
    for (const i of local.issues) console.error(`verifycloud.yaml:${i.line ?? "?"}: ${i.message}`);
    return 2;
  }
  const proj = await resolveProject(client, flag(a, "project"));
  const snap = snapshotDir(dir);
  const json = has(a, "json");
  if (!json) process.stderr.write(`uploading ${snap.files.length} files (${(snap.gz.length / 1024).toFixed(1)} KiB compressed)${snap.skipped.length ? `, skipped ${snap.skipped.length}` : ""}\n`);
  const up = await client.request("POST", `/projects/${proj.id}/snapshots`, { body: snap.gz, contentType: "application/gzip", timeoutMs: 600_000 });
  const body: Record<string, unknown> = { snapshotId: up.snapshot.id };
  const reg = regressionArg ?? flag(a, "regression");
  if (reg) body.regression = reg;
  const tests = a.flags.get("test");
  if (tests?.length) body.tests = tests;
  const key = flag(a, "idempotency-key");
  const r = await client.post(`/projects/${proj.id}/jobs`, body, key ? { "Idempotency-Key": key } : undefined);
  const job = r.job;
  const url = `${client.cfg.apiUrl}/runs/${job.id}`;
  if (!has(a, "wait")) {
    if (json) console.log(JSON.stringify({ job, url }, null, 2));
    else console.log(`job #${job.number} ${job.id} ${job.state}\n${url}`);
    return 0;
  }
  if (!json) process.stderr.write(`job #${job.number} ${job.id}\n${url}\n`);
  const done = await waitJob(client, job.id, json);
  await printJob(client, done.id, json);
  return exitFor(done.state);
}

async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  const [cmd, sub, ...rest] = a._;
  if (has(a, "version")) return void console.log(VERSION), 0;
  if (!cmd || has(a, "help") || cmd === "help") return void console.log(HELP), cmd ? 0 : 2;

  switch (cmd) {
    case "login": {
      const apiUrl = flag(a, "api") ?? process.env.VERIFYCLOUD_API_URL;
      if (!apiUrl) throw new UsageError("login needs --api <url>");
      const u = new URL(apiUrl);
      if (u.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
        throw new UsageError("refusing to send a token over plain http to a non-local host; use https");
      const token = await readSecret("Personal access token (create one under Settings → Tokens): ");
      if (!/^vc_(pat|key)_[A-Za-z0-9_-]{20,}$/.test(token)) throw new UsageError("that does not look like a VerifyCloud token (vc_pat_… or vc_key_…)");
      const c = new Api({ apiUrl: u.toString().replace(/\/+$/, ""), token });
      const me = await c.get("/me");
      saveConfig(c.cfg);
      console.log(`logged in as ${me.user?.email ?? `API key (${me.apiKey?.role})`}; credentials saved to ${configPath()} (mode 600)`);
      return 0;
    }
    case "logout": {
      saveConfig({ apiUrl: "", token: "" });
      console.log("credentials removed");
      return 0;
    }
    case "whoami": {
      const me = await api().get("/me");
      if (me.user) console.log(`${me.user.email}\n${(me.organizations ?? []).map((o: any) => `  ${o.slug} (${o.role})`).join("\n")}`);
      else console.log(`API key ${me.apiKey.id} role ${me.apiKey.role} org ${me.organizations?.[0]?.slug}`);
      return 0;
    }
    case "validate": {
      const dir = resolve(flag(a, "dir") ?? ".");
      const v = validateConfig(readFileSync(resolve(dir, "verifycloud.yaml"), "utf8"));
      if (!v.ok) {
        for (const i of v.issues) console.error(`verifycloud.yaml:${i.line ?? "?"}: ${i.message}`);
        return 2;
      }
      console.log(`ok: ${Object.keys(v.config.tests).length} tests, regressions: ${Object.keys(v.config.regressions).join(", ")}`);
      return 0;
    }
    case "project": {
      const c = api();
      if (sub === "list") {
        if (!rest[0]) throw new UsageError("project list <org>");
        for (const p of (await c.get(`/orgs/${rest[0]}/projects`)).projects) console.log(`${pad(`${rest[0]}/${p.slug}`, 32)} ${p.id}  ${p.name}`);
        return 0;
      }
      if (sub === "create") {
        const [org, slug] = rest;
        if (!org || !slug) throw new UsageError("project create <org> <slug> [--name <name>]");
        const p = (await c.post(`/orgs/${org}/projects`, { slug, name: flag(a, "name") ?? slug })).project;
        console.log(`created ${org}/${p.slug} ${p.id}`);
        return 0;
      }
      if (sub === "connect") {
        const [ref, repo] = rest;
        const inst = Number(flag(a, "installation"));
        if (!ref || !repo || !inst) throw new UsageError("project connect <org/project> <owner/repo> --installation <id>");
        const p = await resolveProject(c, ref);
        const body: Record<string, unknown> = { fullName: repo, installationId: inst };
        if (flag(a, "branch")) body.defaultBranch = flag(a, "branch");
        await c.post(`/projects/${p.id}/repository`, body);
        console.log(`connected ${ref} to ${repo}; pushes and pull requests now trigger runs`);
        return 0;
      }
      throw new UsageError("project list|create|connect");
    }
    case "run":
      return cmdRun(a);
    case "regression": {
      if (sub !== "run" || !rest[0]) throw new UsageError("regression run <name> [options]");
      return cmdRun(a, rest[0]);
    }
    case "status": {
      if (!sub) throw new UsageError("status <job-id>");
      const c = api();
      if (has(a, "wait")) await waitJob(c, sub, has(a, "json"));
      const j = await printJob(c, sub, has(a, "json"));
      return has(a, "wait") ? exitFor(j.state) : 0;
    }
    case "logs": {
      if (!sub) throw new UsageError("logs <task-id> [--grep <text>] [--errors]");
      const q = new URLSearchParams({ limit: flag(a, "limit") ?? "2000" });
      if (flag(a, "grep")) q.set("q", flag(a, "grep")!);
      if (has(a, "errors")) q.set("severity", "error");
      const r = await api().get(`/tasks/${sub}/log?${q}`);
      for (const l of r.lines) console.log(flag(a, "grep") || has(a, "errors") ? `${l.n}: ${l.text}` : l.text);
      if (r.truncated) console.error(`[log truncated by the worker: ${r.truncatedBytes} bytes not kept]`);
      return 0;
    }
    case "coverage": {
      if (!sub) throw new UsageError("coverage <job-id>");
      const r = await api().get(`/jobs/${sub}/coverage`);
      if (has(a, "json")) return void console.log(JSON.stringify(r, null, 2)), 0;
      if (!r.available) return void console.log("no coverage for this job (coverage disabled, or the job has not finished)"), 0;
      console.log(`total     ${fmtCov(r.summary)}${r.tool ? `   (${r.tool})` : ""}`);
      const delta = Object.entries((r.delta ?? {}) as Record<string, { delta: number }>);
      if (delta.length) console.log(`vs #${r.previous?.number}  ${delta.map(([k, v]) => `${k} ${v.delta >= 0 ? "+" : ""}${v.delta.toFixed(1)}pp`).join("   ")}`);
      for (const f of r.files ?? []) console.log(`  ${pad(f.file, 40)} ${fmtCov(f.metrics)}`);
      if (r.functional?.length) {
        console.log("functional cover points:");
        for (const p of r.functional) console.log(`  ${p.count > 0 ? "hit " : "MISS"} ${p.name} (${p.count})`);
      }
      return 0;
    }
    case "artifacts": {
      if (!sub) throw new UsageError("artifacts <job-id> [--download <id> --out <file>]");
      const c = api();
      const dl = flag(a, "download");
      if (dl) {
        const out = flag(a, "out");
        if (!out) throw new UsageError("--download needs --out <file>");
        const res = (await c.request("GET", `/artifacts/${dl}/download`, { raw: true, timeoutMs: 600_000 })) as Response;
        await pipeline(Readable.fromWeb(res.body as any), createWriteStream(out, { flags: "wx" }));
        console.log(`saved ${out}`);
        return 0;
      }
      const j = (await c.get(`/jobs/${sub}`)).job;
      const r = await c.get(`/projects/${j.project_id}/artifacts?job=${sub}`);
      for (const x of r.artifacts) console.log(`${pad(x.kind, 16)} ${pad(x.name, 28)} ${pad(`${(x.size_bytes / 1024).toFixed(1)}KiB`, 12)} ${x.test_name ? `${x.test_name}/${x.seed}` : "-"}  ${x.id}`);
      return 0;
    }
    default:
      throw new UsageError(`unknown command "${cmd}" (see verifycloud --help)`);
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href;
if (isMain || process.env.VERIFYCLOUD_CLI_MAIN === "1") {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      if (e instanceof UsageError) {
        console.error(`error: ${e.message}`);
        process.exit(2);
      }
      if (e instanceof ApiError) {
        console.error(`error: ${e.message} (${e.code}${e.status ? `, HTTP ${e.status}` : ""}${e.requestId ? `, request ${e.requestId}` : ""})`);
        process.exit(e.status >= 400 && e.status < 500 && e.status !== 429 ? 2 : 3);
      }
      console.error(`error: ${(e as Error).message}`);
      process.exit(3);
    },
  );
}

export { main };
