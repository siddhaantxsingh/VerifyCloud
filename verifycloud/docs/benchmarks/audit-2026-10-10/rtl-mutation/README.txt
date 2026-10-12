Bug-injection campaign (2026-10-10). mutate.py ran with host Verilator 5.020 against the demo testbench of the final commit:
  python3 mutate.py <base rtl> <tag> [mutants]   (paths in the script point at the audit workspace)
Bases: the original demo RTL (tag original), rtl_refpatch.sv = the old reference fix (tag refpatch), and the RTL with the current fix-rdata-stable.patch applied (tag regfix).
results-<tag>.jsonl holds per-test results; campaign.log is the console summary.
