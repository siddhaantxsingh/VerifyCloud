# ADR-007: AI-assisted debugging: evidence first, minimal context, never trusted, never merged

Status: accepted (2026-10-07)

## Context

LLMs can produce plausible but wrong diagnoses and patches, and sending
private RTL to a third party may be unacceptable.

## Decision

* Default provider is a deterministic rule-based analyzer, labelled as such in
  every result ("not a language model"). It only states what its rules can
  support with evidence from the log, assertion, RTL and waveform.
* External (OpenAI-compatible) or in-deployment ("local") models are opt-in
  per project; external use additionally requires `allowExternal`.
* Context is built from the failure: log excerpt, the assertion's source lines,
  the RTL lines driving the checked signals, a short waveform window — never a
  whole repository. Project secrets and secret-like patterns are redacted. A
  preview endpoint shows exactly what would be sent and where.
* Model output is validated: file:line locations that do not exist in the
  job's sources are marked `unverified` and confidence is downgraded.
* Patches (AI or user) are applied to a fresh copy of the job's sources and
  verified by running the regression again in isolated workers. VerifyCloud
  never pushes, merges or opens pull requests with patches.

## Consequences

* With no LLM configured, the demo still gets a correct, evidence-backed
  diagnosis (`rtl/axil_regs.sv:131`, verified end to end in the browser test).
* LLM behavior was tested against a local stub only (no API key available);
  real model quality is unmeasured.
