# Bug-injection campaign for the AXI4-Lite demo. Each mutant is one seeded
# defect applied to a base RTL; every test is run against it with real
# Verilator. Output: JSON lines + a summary table.
import json, os, re, shutil, subprocess, sys, time
ROOT = "/tmp/claude-0/audit/rtl"; TB = f"{ROOT}/base"
base = open(sys.argv[1]).read(); tag = sys.argv[2]
M = {  # name: (description, old, new)
 "golden":        ("no change", None, None),
 "strobe_ignored":("write strobes ignored (full-word write)", "r[8*b +: 8] = strb[b] ? data[8*b +: 8] : old[8*b +: 8];", "r[8*b +: 8] = data[8*b +: 8];"),
 "strobe_swapped":("byte lanes of WSTRB reversed", "strb[b] ? data", "strb[3-b] ? data"),
 "id_writable":   ("write to ID returns OKAY instead of SLVERR", "bresp <= SLVERR;\n        end", "bresp <= (aw_addr_q == 8'h10) ? OKAY : SLVERR;\n        end"),
 "unaligned_ok":  ("unaligned read returns OKAY", "if (a[1:0] != 2'b00)            return {SLVERR, 32'h0};", "if (1'b0)                       return {SLVERR, 32'h0};"),
 "scratch_reset": ("SCRATCH reset value wrong", "regs[3] <= 32'hA5A5_0000;", "regs[3] <= 32'h0;"),
 "bvalid_drop":   ("BVALID dropped after one cycle without BREADY", "if (bvalid && bready) bvalid <= 1'b0;", "if (bvalid) bvalid <= 1'b0;"),
 "rvalid_drop":   ("RVALID dropped after one cycle without RREADY", "end else if (rvalid && rready) begin", "end else if (rvalid) begin"),
 "decode_alias":  ("read decode ignores address bit 3", "return {OKAY, regs[a[3:2]]};", "return {OKAY, regs[{1'b0, a[2]}]};"),
 "write_wrong_reg":("write to DATA1 lands in DATA0", "regs[aw_addr_q[3:2]] <= apply_strobe(regs[aw_addr_q[3:2]]", "regs[aw_addr_q[3:2] == 2'd2 ? 2'd1 : aw_addr_q[3:2]] <= apply_strobe(regs[aw_addr_q[3:2]]"),
 "awready_ungated":("AWREADY not gated by the held address (address overwritten)", "assign awready = !aw_held && !bvalid;", "assign awready = !bvalid;"),
 "ar_live_addr":  ("read data from live ARADDR (the original demo bug)", None, None),
}
TESTS = [("smoke",[]),("reset",[]),("wstrb",[]),("error_injection",[]),("rw_overlap",[])] + [("random",[f"+SEED={s}","+OPS=400"]) for s in (1,2,3,4)]
only = sys.argv[3].split(",") if len(sys.argv) > 3 else list(M)
out = open(f"{ROOT}/results-{tag}.jsonl", "a")
for name in only:
    desc, old, new = M[name]
    src = base
    if name == "ar_live_addr":
        continue
    if old is not None:
        assert src.count(old) == 1, (name, src.count(old)); src = src.replace(old, new)
    w = f"{ROOT}/work/{tag}-{name}"; shutil.rmtree(w, ignore_errors=True); os.makedirs(f"{w}/rtl")
    open(f"{w}/rtl/axil_regs.sv", "w").write(src)
    t0 = time.time()
    c = subprocess.run(["verilator","--binary","--timing","--assert","-j","2","--top-module","tb_top","-Mdir",f"{w}/obj","-o","sim",f"{w}/rtl/axil_regs.sv",f"{TB}/tb/axil_checker.sv",f"{TB}/tb/tb_top.sv"], capture_output=True, text=True)
    ct = time.time() - t0
    if c.returncode != 0:
        print(json.dumps({"tag":tag,"mutant":name,"compile":"FAIL","err":c.stderr[-400:]}), file=out, flush=True); print(name, "COMPILE FAIL", c.stderr[-300:]); continue
    res = {}
    for t, extra in TESTS:
        key = t + ("" if not extra else ":" + extra[0].split("=")[1])
        r = subprocess.run([f"{w}/obj/sim", f"+TEST={t}"] + extra, capture_output=True, text=True, timeout=120, cwd=w)
        log = r.stdout + r.stderr
        passed = r.returncode == 0 and "VC_RESULT PASS" in log and not re.search(r"%Error|Assertion failed", log)
        why = ""
        if not passed:
            m = re.search(r"(%Error[^\n]*|VC_CHECK FAIL[^\n]*|Assertion failed[^\n]*)", log); why = m.group(1)[:160] if m else f"exit {r.returncode}"
        res[key] = "PASS" if passed else "FAIL: " + why
    detected = [k for k, v in res.items() if v != "PASS"]
    print(json.dumps({"tag":tag,"mutant":name,"desc":desc,"compile_s":round(ct,1),"results":res,"detected_by":detected}), file=out, flush=True)
    print(f"{name:18} detected_by={detected}")
