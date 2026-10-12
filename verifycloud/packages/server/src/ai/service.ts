// AI debug assistant: orchestration, provider selection, validation,
// persistence and usage accounting.
import { randomUUID } from "node:crypto";

import { applyFilePatch, parseUnifiedDiff, patchedFiles, PatchError } from "@verifycloud/shared";

import type { Ctx } from "../app.js";
import { E } from "../errors.js";
import { readSnapshotFiles } from "../snapshot.js";
import { buildFailureContext, type FailureContext } from "./context.js";
import { heuristicAnalysis } from "./heuristic.js";
import { LlmError, llmAnalysis, llmPatch, type LlmEndpoint } from "./llm.js";
import { INSUFFICIENT, type Analysis } from "./types.js";

export type ProviderName = "heuristic" | "openai" | "local";

export interface ProviderInfo {
  provider: ProviderName;
  available: boolean;
  external: boolean;       // does analysis data leave the VerifyCloud deployment?
  model: string | null;
  endpoint: string | null;
  dataHandling: string;
}

const FAILED_STATES = ["FAILED", "ERROR", "TIMED_OUT", "RESOURCE_EXCEEDED"];

export class AiService {
  constructor(private ctx: Ctx) {}

  providerInfo(settings: { provider?: string; allowExternal?: boolean }): ProviderInfo {
    const { ai } = this.ctx.cfg;
    const p = (settings.provider ?? "heuristic") as ProviderName;
    if (p === "openai")
      return {
        provider: p,
        available: Boolean(ai.openaiBaseUrl && settings.allowExternal),
        external: true,
        model: ai.openaiModel,
        endpoint: ai.openaiBaseUrl ? new URL(ai.openaiBaseUrl).host : null,
        dataHandling:
          "The redacted context listed in the manifest is sent to the configured OpenAI-compatible API. Its retention is governed by that provider's terms, not by VerifyCloud. Requires the project setting allowExternal.",
      };
    if (p === "local")
      return {
        provider: p,
        available: Boolean(ai.localBaseUrl),
        external: false,
        model: ai.localModel,
        endpoint: ai.localBaseUrl ? new URL(ai.localBaseUrl).host : null,
        dataHandling: "The redacted context is sent to a model server operated inside this deployment (AI_LOCAL_BASE_URL); it does not leave your environment if that server is internal.",
      };
    return { provider: "heuristic", available: true, external: false, model: null, endpoint: null, dataHandling: "Rule-based analysis inside VerifyCloud. No data is sent to any model or third party." };
  }

  private endpoint(info: ProviderInfo): LlmEndpoint {
    const { ai } = this.ctx.cfg;
    return info.provider === "openai"
      ? { baseUrl: ai.openaiBaseUrl!, apiKey: ai.openaiApiKey, model: ai.openaiModel, timeoutMs: ai.timeoutMs }
      : { baseUrl: ai.localBaseUrl!, model: ai.localModel, timeoutMs: ai.timeoutMs };
  }

  /** The context that would be sent, without sending it. */
  async preview(taskId: string) {
    const c = await buildFailureContext(this.ctx, taskId, this.ctx.cfg.ai.maxContextBytes);
    return { manifest: c.manifest, redactions: c.redactions, files: c.files.map((f) => ({ path: f.path, startLine: f.startLine, endLine: f.endLine, reason: f.reason })) };
  }

  /** Mark cited locations as verified/unverified against the job's sources; never keep invented locations as facts. */
  validate(a: Analysis, c: FailureContext): Analysis {
    const exists = (file: string, line: number) => {
      const key = Object.keys(c.fileLineCounts).find((p) => p === file || p.endsWith("/" + file) || file.endsWith("/" + p));
      return key !== undefined && line >= 1 && line <= c.fileLineCounts[key]!;
    };
    const locations = a.locations.map((l) => ({ ...l, verified: exists(l.file, l.line) }));
    const bad = locations.filter((l) => !l.verified);
    const notes = [...a.notes];
    if (bad.length) notes.push(`${bad.length} cited location(s) do not exist in this job's sources and are marked unverified: ${bad.map((l) => `${l.file}:${l.line}`).join(", ")}`);
    let confidence = a.confidence;
    let insufficient = a.insufficientEvidence;
    if (!insufficient && a.evidence.length === 0) {
      insufficient = true;
      notes.push("The answer cited no evidence; treated as insufficient.");
    }
    if (bad.length && confidence !== "low") confidence = confidence === "high" ? "medium" : "low";
    return { ...a, locations, confidence, insufficientEvidence: insufficient, rootCause: insufficient && !a.rootCause.startsWith(INSUFFICIENT) ? `${INSUFFICIENT} (${a.rootCause})` : a.rootCause, notes };
  }

  async analyze(taskId: string, userId: string | null): Promise<Record<string, any>> {
    const { db, metrics } = this.ctx;
    const t = (await db.query("SELECT t.*, p.ai_settings, pl.ai_tokens_per_month FROM tasks t JOIN projects p ON p.id = t.project_id JOIN organizations o ON o.id = t.org_id JOIN plans pl ON pl.name = o.plan WHERE t.id = $1", [taskId])).rows[0];
    if (!FAILED_STATES.includes(t.state)) throw E.conflict("TASK_NOT_FAILED", "only failed, errored, timed-out or resource-exceeded runs can be analyzed");
    const info = this.providerInfo(t.ai_settings ?? {});
    if (!info.available) throw E.conflict("AI_PROVIDER_UNAVAILABLE", `AI provider "${info.provider}" is not configured or not allowed for this project`);
    if (info.provider !== "heuristic") {
      const used = await db.query(
        "SELECT coalesce(sum(quantity), 0)::bigint AS n FROM usage_records WHERE org_id = $1 AND kind IN ('ai_tokens_in','ai_tokens_out') AND created_at > date_trunc('month', now())",
        [t.org_id],
      );
      if (Number(used.rows[0].n) >= Number(t.ai_tokens_per_month)) throw E.quota("monthly AI token quota of the organization exhausted");
    }
    const id = randomUUID();
    await db.query(
      "INSERT INTO ai_analyses (id, org_id, project_id, job_id, task_id, provider, model, external, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)",
      [id, t.org_id, t.project_id, t.job_id, taskId, info.provider, info.model, info.external, userId],
    );
    const t0 = performance.now();
    try {
      const c = await buildFailureContext(this.ctx, taskId, this.ctx.cfg.ai.maxContextBytes);
      const manifest = { items: c.manifest, redactions: c.redactions, provider: info.provider, external: info.external, endpoint: info.endpoint, model: info.model };
      await db.query("UPDATE ai_analyses SET context_manifest = $2 WHERE id = $1", [id, JSON.stringify(manifest)]);
      const r = info.provider === "heuristic" ? { analysis: heuristicAnalysis(c), model: null, tokensIn: null, tokensOut: null } : await llmAnalysis(this.endpoint(info), c);
      const analysis = this.validate(r.analysis, c);
      const ms = Math.round(performance.now() - t0);
      metrics.aiLatency.observe(ms / 1000, { provider: info.provider });
      await db.query("UPDATE ai_analyses SET status = 'succeeded', result = $2, tokens_in = $3, tokens_out = $4, latency_ms = $5 WHERE id = $1", [id, JSON.stringify(analysis), r.tokensIn, r.tokensOut, ms]);
      for (const [kind, n] of [["ai_tokens_in", r.tokensIn], ["ai_tokens_out", r.tokensOut]] as const)
        if (n) await db.query("INSERT INTO usage_records (org_id, project_id, job_id, kind, quantity, source_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [t.org_id, t.project_id, t.job_id, kind, n, `ai:${id}:${kind}`]);
    } catch (e) {
      const reason = e instanceof LlmError ? e.reason : "internal";
      metrics.aiFailures.inc({ provider: info.provider, reason });
      // provider errors are meant for users; internal errors (storage keys,
      // stack details) are logged, not stored where viewers can read them (audit)
      const shown = e instanceof LlmError ? (e as Error).message.slice(0, 500) : "internal error during analysis (see server logs)";
      await db.query("UPDATE ai_analyses SET status = 'failed', error = $2, latency_ms = $3 WHERE id = $1", [id, shown, Math.round(performance.now() - t0)]);
      if (!(e instanceof LlmError)) this.ctx.log.error({ err: (e as Error).message, stack: (e as Error).stack }, "analysis failed");
    }
    return (await db.query("SELECT * FROM ai_analyses WHERE id = $1", [id])).rows[0];
  }

  /** Check that a patch only touches allowed files and applies cleanly to the job's sources. */
  async checkPatch(jobId: string, diff: string): Promise<{ files: string[] }> {
    let fps;
    try {
      fps = parseUnifiedDiff(diff);
    } catch (e) {
      throw E.validation(`invalid patch: ${(e as Error).message}`);
    }
    const files = patchedFiles(fps);
    const j = (await this.ctx.db.query("SELECT source, org_id FROM jobs WHERE id = $1", [jobId])).rows[0];
    const artId = j?.source?.artifactId;
    if (!artId) throw E.conflict("SOURCES_UNAVAILABLE", "the job's sources are not available (build did not complete or sources expired)");
    const a = (await this.ctx.db.query("SELECT storage_key FROM artifacts WHERE id = $1 AND org_id = $2", [artId, j.org_id])).rows[0];
    if (!a) throw E.conflict("SOURCES_UNAVAILABLE", "the job's sources expired under the retention policy");
    const contents = await readSnapshotFiles(await this.ctx.store.getBuffer(a.storage_key, 256 * 1024 * 1024), (p) => files.includes(p), 4 * 1024 * 1024);
    for (const fp of fps) {
      try {
        applyFilePatch(fp.oldPath === null ? null : (contents.get(fp.oldPath) ?? null), fp);
      } catch (e) {
        if (e instanceof PatchError) throw E.validation(`patch does not apply: ${e.message}`);
        throw e;
      }
      if (fp.oldPath && !contents.has(fp.oldPath)) throw E.validation(`patch modifies ${fp.oldPath}, which is not in the job's sources`);
    }
    return { files };
  }

  async generatePatch(analysisId: string, userId: string | null): Promise<Record<string, any>> {
    const { db } = this.ctx;
    const an = (await db.query("SELECT a.*, p.ai_settings FROM ai_analyses a JOIN projects p ON p.id = a.project_id WHERE a.id = $1", [analysisId])).rows[0];
    if (an.status !== "succeeded") throw E.conflict("ANALYSIS_NOT_READY", "the analysis did not succeed");
    const info = this.providerInfo(an.ai_settings ?? {});
    if (info.provider === "heuristic")
      throw E.conflict("PATCH_GENERATION_UNAVAILABLE", "the rule-based analyzer does not generate patches; configure an LLM provider for the project or submit a patch yourself");
    if (!info.available) throw E.conflict("AI_PROVIDER_UNAVAILABLE", "AI provider not configured or not allowed for this project");
    const c = await buildFailureContext(this.ctx, an.task_id, this.ctx.cfg.ai.maxContextBytes);
    let r;
    try {
      r = await llmPatch(this.endpoint(info), c, an.result);
    } catch (e) {
      this.ctx.metrics.aiFailures.inc({ provider: info.provider, reason: e instanceof LlmError ? e.reason : "internal" });
      throw E.unavailable(`patch generation failed: ${(e as Error).message}`);
    }
    if (!r.diff.trim()) throw E.conflict("NO_PATCH_PROPOSED", `the model did not propose a patch: ${r.explanation || "no explanation"}`);
    // A model-generated patch may only touch the RTL/testbench files it was
    // shown, never the project configuration, and never the checker whose
    // failure it is meant to fix (deleting a failing assertion would "pass"
    // the verification job). Injected instructions in the evidence therefore
    // cannot steer it elsewhere (audit P2). Users can still submit such a
    // patch themselves.
    const fps = (() => {
      try {
        return parseUnifiedDiff(r.diff);
      } catch {
        return null;
      }
    })();
    if (fps) {
      const shown = new Set(c.files.map((f) => f.path));
      const checkers = new Set(c.assertions.map((a) => a.file));
      for (const fp of fps) {
        const path = fp.newPath ?? fp.oldPath ?? "";
        if (fp.oldPath === null || fp.newPath === null || fp.oldPath !== fp.newPath)
          throw E.conflict("PATCH_REJECTED", `the model's patch creates, deletes or renames ${path}; only edits of shown source files are accepted`);
        if (/(^|\/)verifycloud\.ya?ml$/.test(path)) throw E.conflict("PATCH_REJECTED", "the model's patch modifies the project configuration");
        if (!shown.has(path)) throw E.conflict("PATCH_REJECTED", `the model's patch modifies ${path}, which was not part of the evidence it was shown`);
        if (checkers.has(path)) throw E.conflict("PATCH_REJECTED", `the model's patch modifies ${path}, which defines the failing assertion; submit a manual patch if the checker itself is wrong`);
      }
    }
    const { files } = await this.checkPatch(an.job_id, r.diff);
    const id = randomUUID();
    await db.query(
      "INSERT INTO patches (id, org_id, project_id, job_id, analysis_id, origin, diff, files, created_by) VALUES ($1,$2,$3,$4,$5,'ai',$6,$7,$8)",
      [id, an.org_id, an.project_id, an.job_id, analysisId, r.diff, files, userId],
    );
    for (const [kind, n] of [["ai_tokens_in", r.tokensIn], ["ai_tokens_out", r.tokensOut]] as const)
      if (n) await db.query("INSERT INTO usage_records (org_id, project_id, job_id, kind, quantity, source_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [an.org_id, an.project_id, an.job_id, kind, n, `aipatch:${id}:${kind}`]);
    return { ...(await db.query("SELECT * FROM patches WHERE id = $1", [id])).rows[0], explanation: r.explanation };
  }
}
