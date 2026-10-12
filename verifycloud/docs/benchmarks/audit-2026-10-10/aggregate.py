import glob, json, math, re, statistics as st, sys
O = "/tmp/claude-0/audit/bench"
T95 = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262}

def ci(xs):
    n = len(xs)
    m = st.mean(xs)
    if n < 2: return {"n": n, "mean": round(m, 2), "stdev": None, "ci95": None, "min": round(min(xs), 2), "max": round(max(xs), 2)}
    sd = st.stdev(xs); h = T95[n - 1] * sd / math.sqrt(n)
    return {"n": n, "mean": round(m, 2), "stdev": round(sd, 2), "ci95": [round(m - h, 2), round(m + h, 2)], "cv_pct": round(100 * sd / m, 1) if m else None, "min": round(min(xs), 2), "max": round(max(xs), 2)}

def load(pat):
    out = []
    for f in sorted(glob.glob(f"{O}/{pat}")):
        try: out.append(json.load(open(f)))
        except Exception as e: print("unreadable", f, e, file=sys.stderr)
    return out

def timefile(f):
    t = open(f).read()
    g = lambda k: re.search(rf"{k}: (.*)", t).group(1).strip()
    el = g("Elapsed \\(wall clock\\) time \\(h:mm:ss or m:ss\\)"); parts = [float(x) for x in el.split(":")]
    wall = parts[-1] + 60 * parts[-2] + (3600 * parts[-3] if len(parts) > 2 else 0)
    return {"wallSeconds": round(wall, 1), "cpuPercentOfOneCore": g("Percent of CPU this job got"), "maxRssMiB": round(int(g("Maximum resident set size \\(kbytes\\)")) / 1024, 1), "exit": int(g("Exit status"))}

res = {}
sch = load("scheduler-*.json")
res["scheduler"] = {"runs": len(sch), "byWorkers": {}}
for w in sorted({r["workers"] for d in sch for r in d["results"]}):
    rows = [r for d in sch for r in d["results"] if r["workers"] == w]
    res["scheduler"]["byWorkers"][w] = {"tasksPerSecond": ci([r["tasksPerSecond"] for r in rows]), "claimP95Ms": ci([r["claimLatencyMs"]["p95"] for r in rows]), "completeP95Ms": ci([r["completeLatencyMs"]["p95"] for r in rows]), "tasksClaimed": sum(r["tasks"] for r in rows), "tasksExecutedTwice": sum(r["tasksExecutedTwice"] for r in rows), "allPassed": all(r["allTasksPassed"] for r in rows)}
api = load("api-*.json")
res["api"] = {"runs": len(api), "byScenario": {}}
for d in api[:1]:
    for r0 in d["results"]:
        key = f'{r0["endpoint"]} c={r0["concurrency"]}'
        rows = [r for dd in api for r in dd["results"] if r["endpoint"] == r0["endpoint"] and r["concurrency"] == r0["concurrency"]]
        res["api"]["byScenario"][key] = {"rps": ci([r["rps"] for r in rows]), "p95Ms": ci([r["latencyMs"]["p95"] for r in rows]), "errors": sum(r["errors"] for r in rows)}
sb = load("sandbox-*.json")
res["sandbox"] = {"runs": len(sb), "bySlots": {}}
for k in sorted({r["sandboxSlots"] for d in sb for r in d["results"]}):
    rows = [r for d in sb for r in d["results"] if r["sandboxSlots"] == k]
    res["sandbox"]["bySlots"][k] = {"runsPerMinute": ci([r["runsPerMinute"] for r in rows]), "perRunP50s": ci([r["perRunSeconds"]["p50"] for r in rows]), "passed": f'{sum(r["passed"] for r in rows)}/{sum(r["testRuns"] for r in rows)}', "states": sorted({r["jobState"] for r in rows})}
try:
    c = json.load(open(f"{O}/costs.json"))
    res["costs"] = {k: c[k] for k in ("containerStartTeardownSeconds", "coldBuildSeconds", "cacheHitBuildSeconds")}
except Exception as e:
    res["costs"] = f"missing: {e}"
res["process"] = {f.split("/")[-1][:-5]: timefile(f) for f in sorted(glob.glob(f"{O}/*.time"))}
try:
    rows = [l.split() for l in open(f"{O}/vmstat.log") if re.match(r"\s*\d", l)]
    idle = [int(r[14]) for r in rows]; wa = [int(r[15]) for r in rows]
    res["hostCpu"] = {"samples": len(rows), "meanIdlePct": round(st.mean(idle), 1), "meanIowaitPct": round(st.mean(wa), 1), "minFreeMiB": round(min(int(r[3]) for r in rows) / 1024)}
except Exception as e:
    res["hostCpu"] = f"missing: {e}"
print(json.dumps(res, indent=1))
