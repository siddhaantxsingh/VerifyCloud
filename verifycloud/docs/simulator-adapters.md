# Simulator adapters

Supported: **Verilator** (verified with 5.020 in `verifycloud-sim:verilator`,
Ubuntu 24.04 + `verilator`, `g++`, `make`). No other simulator is supported
or claimed.

## Interface

`packages/worker/src/adapters/types.ts`:

```ts
interface SimulatorAdapter {
  engine: "verilator";
  validate(cfg: ProjectConfig): string[];                       // engine-specific checks
  cacheKeyMaterial(cfg, toolchain): Record<string, unknown>;    // what invalidates a model
  buildPlan(cfg, sources, cpus, waveforms): BuildPlan;          // command + support files
  parseBuild(log: string, exitCode: number | null): BuildResult; // diagnostics with file:line
  runPlan(cfg, plusargs, opts): RunPlan;                        // command, coverage/waveform files
  parseRun(log: string, exitCode: number | null): RunResult;    // pass/fail, assertions, checks, sim time
  parseCoverage(raw: string, include: string[]): CoverageDetail;
}
```

Adapters only produce commands and parse text. They never execute anything:
the worker runs their plans inside the sandbox.

## Verilator adapter

Build (inside a sandbox; sources read-only at `/work/src`; the harness is part
of the simulator image at `/opt/verifycloud/harness/vc_main.cpp`; a generated
`vc_top.h` and `build.sh` are mounted read-only at `/work/vc`):

```text
verilator --cc --exe --build -j <cpus> --top-module <top> -Mdir /work/scratch/obj -o sim
          --timing|--no-timing [--assert] [--coverage-line] [--coverage-toggle]
          [--coverage-user] [--trace] -I<dirs> +define+<k>=<v> <user flags>
          <rtl + tb sources> /opt/verifycloud/harness/vc_main.cpp
```

The model is copied to `/work/out/sim`, compressed and uploaded; its cache key
is the sha256 of the sorted source files and contents, the resolved
simulator settings, the image digest, Verilator and GCC versions and the
harness hash.

Run: the sources are copied to a scratch directory (testbenches may read data
files relative to the working directory) and the model is executed with the
test's plusargs plus `+vc_coverage=/work/out/coverage.dat` and
`+vc_trace=/work/out/waves.vcd`.

### Harness (`packages/worker/harness/vc_main.cpp`)

* `Verilated::fatalOnError(false)`: `$stop`/`$fatal`/assertion failures end
  the simulation cleanly instead of `abort()`, so coverage and the VCD are
  still written;
* evaluates the model until `$finish`, an error, or no more events;
* writes coverage and closes the trace on every exit path;
* prints `VC_SIM_END finish=<0|1> error=<0|1> time=<t> timeunit=<exp>`;
* exit code 0 (pass), 1 (error/assertion), 3 (ended without `$finish`).

### Output parsing

* `%Error: file:line: Assertion failed in <scope>: <message>` →
  assertion failure (name from the scope; immediate assertions inside
  unnamed blocks are reported as self-check failures);
* `%Error`/`%Warning` during build → diagnostics with file and line;
* `VC_CHECK FAIL`, `VC_RESULT` markers → self-check failures/result;
* exit by signal (e.g. 139 SIGSEGV) → `FAILED` with the code recorded.

### Known Verilator 5.020 limitations met while building this

* an `and` of two implications inside one property is rejected — write two
  assertions;
* the `--binary` generated main writes no coverage and aborts on `$stop` —
  hence the harness;
* `+verilator+error+limit` makes `$fatal` non-fatal and can hang a run — not
  used;
* testbenches that drive inputs at the same clock edge the DUT samples race;
  drive at the opposite edge (the demo drives at negedge).

## Adding a simulator

1. Build an image with the tool (and its license configuration, if any — a
   license server must be reachable, which conflicts with `--network none`;
   that needs a dedicated, restricted network instead of `none`).
2. Implement `SimulatorAdapter`; register it in `ADAPTERS`
   (`packages/worker/src/runner.ts`) and add the engine name to
   `SUPPORTED_ENGINES` (`packages/shared/src/config.ts`).
3. Provide a harness or wrapper with the same contract: deterministic exit
   codes, coverage on every exit path, a machine-readable end marker.
4. Add adapter unit tests with real tool output (see
   `packages/server/test/fixtures/`) and a real-sandbox test.
