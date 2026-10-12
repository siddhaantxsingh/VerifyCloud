# ADR-004: One locked-down container per build/test run; workers hold no platform credentials

Status: accepted (2026-10-07)

## Context

Simulation jobs are untrusted: users control the RTL, the testbench and (via
Verilator) C++ that is compiled and executed. SystemVerilog `$system`, DPI
and plain C++ give arbitrary code execution inside the run.

## Decision

* The API never compiles or runs user code.
* Workers run every build and every test in a fresh Docker container:
  `--network none`, `--read-only` root, `--cap-drop ALL`,
  `--security-opt no-new-privileges`, Docker's default seccomp profile, uid
  10001, `--init`, `--pids-limit`, `--memory` = `--memory-swap`, `--cpus`,
  `nofile`/`core` ulimits, `noexec` tmpfs `/tmp`, a size-limited scratch
  tmpfs, sources/harness/model mounted read-only, one writable output
  directory whose size is monitored. Output volume and wall time are enforced
  by the worker, which kills the container on violation. An optional OCI
  runtime (`SANDBOX_RUNTIME=runsc`, gVisor) adds a user-space kernel.
* Workers talk only to `/internal/v1` with a per-worker token and a per-task
  lease; they have no database or object-storage credentials. Source code
  reaches them via the API (snapshot) or a short-lived, repository-scoped
  GitHub installation token used only for the fetch and never passed into the
  sandbox.

## Consequences

* Verified with real containers: no network, no DNS, read-only sources and
  root, `CapEff` 0, uid 10001, no Docker socket, `noexec` /tmp, no secrets in
  the environment, fork bomb contained, memory exhaustion → `RESOURCE_EXCEEDED`,
  output flood → killed, endless simulation → `TIMED_OUT`
  (`packages/worker/test/sandbox.test.ts`).
* The worker itself controls the Docker daemon, which is root-equivalent on
  its host. Worker hosts must be dedicated machines/VMs without other secrets
  (docs/worker-security.md). Rootless Docker or gVisor reduce, but do not
  remove, the impact of a container escape.
* Container start adds overhead per run (measured in docs/performance.md).
