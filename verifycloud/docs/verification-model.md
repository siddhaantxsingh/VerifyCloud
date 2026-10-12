# Verification model and `verifycloud.yaml`

## Concepts

| Term | Meaning |
| --- | --- |
| **Project** | One RTL code base (a GitHub repository or uploaded snapshots) with one `verifycloud.yaml`. |
| **Test** | A named testbench mode, selected with a plusarg (`+TEST=<name>` by default). |
| **Seed** | A value passed as `+SEED=<n>`; a test with seeds `[1..8]` produces 8 **test runs**. |
| **Regression** | A named list of tests. Running a regression creates a **job**. |
| **Job** | One build task plus one task per (test, seed). Results, merged coverage, assertions and artifacts belong to it. |
| **Build** | Verilator compiles the design + testbench + harness once per job; the model is cached by content (sources, configuration, toolchain). |

Pass/fail of a run is decided by the simulator outcome, not by log text alone:
a run passes if the simulation reached `$finish` without errors (`VC_SIM_END
finish=1 error=0`) and exited 0. Assertion failures (`$error` in SVA action
blocks, failed immediate assertions), `$fatal`, `$stop`, a crash (signal),
and self-check markers make it fail. Running out of time or memory, or
printing more than the output limit, ends it as `TIMED_OUT` or
`RESOURCE_EXCEEDED` with the reason recorded.

## Configuration reference

```yaml
version: 1                      # required, only 1

project:
  name: my-ip                   # required, [A-Za-z][A-Za-z0-9_.-]{0,63}

rtl:
  sources: ["rtl/**/*.sv"]      # required, globs relative to the repository root
  include_dirs: ["rtl/include"] # optional
  defines: { WIDTH: "32" }      # optional, -D<name>=<value>

testbench:
  sources: ["tb/*.sv"]          # required
  top: tb_top                   # required, top module

simulator:
  engine: verilator             # required; the only supported engine
  timing: true                  # --timing (delays, @, fork in testbenches); default false
  assertions: true              # --assert (SVA); default true
  flags: ["-Wno-WIDTH"]         # extra Verilator flags; flags that change outputs,
                                # inputs, compilers or the harness are rejected
  coverage:                     # or `coverage: true` for all four
    line: true
    branch: true
    toggle: true
    functional: true            # SVA cover properties
  waveform: on_failure          # never | on_failure (default) | always
  test_plusarg: TEST            # default TEST
  seed_plusarg: SEED            # default SEED

coverage:
  include: ["rtl/**"]           # files code coverage is reported for (default: all)

tests:
  smoke: {}                                   # +TEST=smoke, seed 1
  random:
    plusargs: { OPS: "400" }                  # extra plusargs
    seeds: { range: [1, 8] }                  # or a list: [1, 2, 3]
    timeout_seconds: 120                      # per run (default resources.timeout_seconds)
    retries: 1                                # re-run a failure; pass-after-fail is reported flaky

regressions:                    # at least one
  smoke: { tests: [smoke] }
  full:  { tests: [smoke, random] }
# shorthand for a single regression named "default":
# regression: { tests: [smoke] }

resources:
  cpu: 2                        # per build/test run, 1..16
  memory_mb: 2048               # per test run, 256..65536
  compile_memory_mb: 4096       # build; default max(memory_mb, 2048)
  timeout_seconds: 300          # per test run
  compile_timeout_seconds: 600
  disk_mb: 2048                 # scratch space per run
```

Validation reports every problem with its line number (`verifycloud validate`,
the web editor, snapshot upload and job creation all use the same validator,
`packages/shared/src/config.ts`). Platform limits: 500 tests, 1,000 seeds per
test, 5,000 runs per regression; plans lower these (`free`: 200 runs per job).

Which regression runs automatically: pull requests run `pr` if defined,
pushes run `push` if defined; otherwise `default`, otherwise the first one.

## Testbench contract

Any SystemVerilog testbench that Verilator can compile works. Conventions that
improve reports (all optional):

* `$display("VC_TEST_START test=%s seed=%0d", ...)` at the start;
* `$display("VC_CHECK FAIL <message>")` for scoreboard mismatches (counted
  as self-check failures and quoted in summaries);
* `$display("VC_RESULT PASS")` / `VC_RESULT FAIL` at the end.

Read the plusargs with `$value$plusargs("TEST=%s", t)` and
`$value$plusargs("SEED=%d", s)`; seed your own random generators from `+SEED`.

## Coverage

Verilator's coverage database is parsed into points
(`file, line, type, count, label`): `line` (statement blocks), `branch`,
`toggle`, and `functional` = SVA `cover property` hits. A job's coverage is the
union over its runs (a point is covered if any run hit it). Reports: summary,
per file with uncovered lines, functional cover points with hit counts, per
test run, delta against the previous run of the same regression and branch,
and history over time.

Numbers are what Verilator measures: its "line" coverage counts statement
blocks, so a fully covered design can show a small total (the demo: 7/7).

## Waveforms

With `waveform: on_failure` every run is traced (`+vc_trace`) and the VCD is
uploaded only if the run failed; `always` keeps all; `never` disables tracing
(fastest). VCDs larger than `MAX_WAVEFORM_BYTES` are not uploaded (reported).
The viewer opens at the assertion time.

## Reproducibility

Each job records: source (commit SHA or snapshot artifact + sha256), the
resolved configuration and its sha256, the toolchain (image digest, Verilator
and GCC versions, harness sha256, sandbox runtime) and each run's plusargs and
seed. **Re-run** creates a new job from exactly those inputs; the
**Reproduce** tab shows the commands to run the same simulation locally.

## Flakiness

A test with `retries: n` that fails is re-queued up to `n` times; the evidence
of each failed attempt is kept. If a later attempt passes, the run is
`PASSED` and marked **flaky**. Test history pages show pass/fail/flaky per
run over time.

## What the model does not cover (yet)

UVM (Verilator 5.020 cannot run UVM), 4-state X semantics, mixed-language
designs, formal verification, gate-level simulation, FST waveforms,
commercial simulators.
