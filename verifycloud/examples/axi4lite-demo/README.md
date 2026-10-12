# AXI4-Lite demo project

Synthetic, public example RTL used by VerifyCloud's demo mode and tests.
Nothing here comes from a company design.

| Path | Content |
| --- | --- |
| `rtl/axil_regs.sv` | AXI4-Lite slave: 4 RW registers, a read-only ID register, byte strobes, SLVERR for unmapped/misaligned addresses |
| `tb/axil_checker.sv` | 8 SVA assertions (handshake stability, legal responses) and 10 cover properties (functional coverage, including the order in which AW and W are accepted) |
| `tb/tb_top.sv` | self-checking testbench with a reference model; tests `smoke`, `reset`, `wstrb`, `error_injection`, `rw_overlap`, `random` (seeded) |
| `verifycloud.yaml` | project configuration: regressions `smoke` and `full` (random test with seeds 1–8) |
| `fix-rdata-stable.patch` | the reference fix for the intentional bug (see below) |

## The intentional bug

The read-data path decodes the **live** `araddr` input instead of the address
captured at the AR handshake. While the master holds off `RREADY`, a master
that already presents its next address changes `RDATA`, which AXI forbids
(`RDATA` must be stable while `RVALID && !RREADY`).

* The directed tests `smoke`, `reset`, `wstrb` and `error_injection` keep
  `ARADDR` unchanged during a read and **pass**.
* The `random` test applies read back-pressure and changes `ARADDR` early: the
  assertion `rdata_stable` (tb/axil_checker.sv) fails, and the scoreboard
  reports wrong read data.
* The directed test `rw_overlap` writes the register that is being read while
  `RREADY` is held low; `RDATA` changes, so it fails as well.

The fix registers `RDATA`/`RRESP` at the AR handshake. (An earlier version of
`fix-rdata-stable.patch` only decoded the registered address; `RDATA` was then
still combinational from the register file and changed when a write landed
during the stall. `rw_overlap` was added in the 2026-10-10 audit to catch
exactly that, and it fails with the old patch.)

The RTL source itself contains no hint of the bug, so a diagnosis (human or AI)
has to come from the evidence: the assertion, the log and the waveform.

Measured with Verilator 5.020 (`--binary --timing --assert`, 2026-10-10 audit,
`random` seeds 1–4 with `OPS=400`):
buggy RTL — `smoke`, `reset`, `wstrb`, `error_injection` pass; `rw_overlap` and
`random` fail; old patch — only `rw_overlap` fails; current patch — all pass.
Known testbench gap: the master never has two write addresses outstanding, so
a slave that overwrites a held write address (AWREADY not gated) is **not**
detected (see docs/audit-2026-10-08/test-report.md, bug-injection campaign).

## Running without VerifyCloud

```bash
verilator --binary --timing --assert -Wno-fatal --top-module tb_top \
  rtl/axil_regs.sv tb/axil_checker.sv tb/tb_top.sv
./obj_dir/Vtb_top +TEST=random +SEED=1 +OPS=400
```

With the buggy RTL this stops at the `rdata_stable` assertion (time 75000 for
seed 1); Verilator's generated `--binary` main aborts on `$stop`, which is why
VerifyCloud builds with its own harness (coverage and waveforms are kept on
failure). Apply the fix with `patch -p1 < fix-rdata-stable.patch`.
