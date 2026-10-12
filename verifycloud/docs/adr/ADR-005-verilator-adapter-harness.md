# ADR-005: Verilator is the only simulator; adapters behind an interface; a custom harness

Status: accepted (2026-10-07)

## Context

Commercial simulators (Questa, Xcelium, VCS) need licenses not available here;
Icarus was not installed. Claiming support without running them would be false.
Verilator's generated `--binary` main does not write coverage, and `$stop` /
`$fatal` abort the process, losing coverage and waveforms on failure.

## Decision

* `SimulatorAdapter` (validate, cacheKeyMaterial, buildPlan, parseBuild,
  runPlan, parseRun, parseCoverage) isolates simulator specifics; the only
  implementation is `VerilatorAdapter` (Verilator 5.020 verified).
* The worker compiles the model with a small C++ harness (`vc_main.cpp`):
  `fatalOnError(false)`, plusargs for coverage/trace files, writes coverage and
  closes the VCD on every exit path, prints `VC_SIM_END finish= error= time=`
  and exits 0/1/3.
* User simulator flags are validated against a deny-list of flags that change
  outputs, inputs, compilers or the harness contract.

## Consequences

* Coverage and waveforms are available for failing tests, which is what
  debugging needs.
* Adding a simulator means implementing the interface and shipping an image
  with that tool; nothing in the scheduler or UI is Verilator-specific except
  labels (docs/simulator-adapters.md).
* Verilator ≠ a 4-state event simulator: X-propagation, some SVA constructs
  and UVM are not supported by this backend; the docs say so.
