# ADR-001: One TypeScript monorepo for API, worker, CLI and web

Status: accepted (2026-10-07)

## Context

VerifyCloud has five deliverables that share data shapes: the API, the
worker, the CLI, the web dashboard and the configuration/coverage/VCD/patch
logic used by all of them. Configuration validation in particular must give
identical answers in the CLI (`verifycloud validate`), the API (on upload and
job creation) and the web editor.

## Decision

A single npm-workspaces monorepo in TypeScript (strict mode):

* `packages/shared` — configuration parser/validator, project detection,
  coverage parsing/merging, partial SystemVerilog indexer, VCD parser, unified
  diff applier, deterministic tar writer, redaction.
* `packages/server` — Fastify 5 + TypeBox (schemas generate the OpenAPI
  document), `pg`, AWS SDK v3 for S3.
* `packages/worker` — sandbox driver and simulator adapters.
* `packages/cli` — `verifycloud` command.
* `packages/web` — React 19 + Vite.

## Consequences

* One language, one test runner (Vitest), one type system across the API
  boundary; the OpenAPI document is generated from the same TypeBox schemas
  that validate requests.
* Node is single-threaded: CPU-heavy work (coverage merging, VCD indexing) is
  bounded by size limits and done by workers where possible.
* Python/Go tooling common in EDA flows is not used inside the platform; the
  simulator runs in its own container image regardless.
