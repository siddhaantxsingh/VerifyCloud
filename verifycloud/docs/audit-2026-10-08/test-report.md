# C. Test report

Every result below comes from a command that was actually executed. Logs
are in the audit workspace (`/tmp/claude-0/audit/logs/`, not part of the
repository); their names are given in brackets.

## 1. Environment

The host had 2 vCPUs, 7.8 GiB RAM and Linux 6.18. Software: Node 22.22,
PostgreSQL 16.15 (local cluster), Docker 29.8.2 and Verilator 5.020 inside
the `verifycloud-sim:verilator` image. Object storage was moto 5.x on
127.0.0.1:9000, standing in for MinIO, which is unreachable from this
network. Chromium came from `/opt/pw-browsers`.

The environment restarted several times during the audit (dockerd, PostgreSQL
and moto were stopped). The services were restarted before each run, and no
result below spans a restart.

## 2. Clean build reproduction (Phase 2)

The input was the zip as delivered, extracted into an empty directory:
sha256 `bdd2767e…`, tree identical to git `8fdc165`.

| Step | Baseline (8fdc165) | Final (6d4fb5d) |
| --- | --- | --- |
| `npm ci` | ok | (same lockfile) |
| `npm run typecheck` | ok | ok [final-typecheck.log] |
| `npm run lint` | ok, but it is only `tsc --noEmit` (no ESLint/formatter: finding O4) | — |
| `npm run build` | ok | ok [final-build.log] |
| `npm audit --omit=dev` | 0 vulnerabilities | 0 vulnerabilities [final-audit.log] |
| `npx vitest run` (all suites, including real Docker sandbox and failure injection) | **81/81** passed, 340 s [vitest-baseline.log] | **143/143** passed, 14 files, 345 s [vitest-final.log] |
| Browser E2E (Playwright, host processes) | 2/2 [e2e-baseline.log] | **2/2** [e2e-final-host.log] |
| Browser E2E against the Compose stack (substitutes) | — | **2/2** [e2e-compose-final.log] |

Final suite by file:

| File | Tests | Real components |
| --- | --- | --- |
| shared/units.test.ts | 16 | — |
| shared/audit-redact.test.ts | 17 | — |
| web/nav.test.ts | 2 | — |
| cli/cli.test.ts | 7 | PostgreSQL, S3 emulator, API |
| server/scheduler.test.ts | 16 | PostgreSQL |
| server/audit-scheduler.test.ts | 12 | PostgreSQL (raw pg clients hold locks) |
| server/security.test.ts | 16 | PostgreSQL, S3 emulator |
| server/audit-security.test.ts | 12 | PostgreSQL, fake GitHub OAuth server |
| server/integrations.test.ts | 17 | PostgreSQL, S3 emulator, fake GitHub API, stub LLM |
| server/audit-ai.test.ts | 2 | — |
| server/audit-storage.test.ts | 3 | PostgreSQL, S3 emulator |
| worker/audit-units.test.ts | 7 | Verilator adapter parsing, filesystem |
| worker/sandbox.test.ts | 12 | Docker, Verilator, worker, API |
| worker/recovery.test.ts | 4 | Docker, Verilator, worker, API, PostgreSQL restart (`pg_ctlcluster`), TCP outage proxy |

## 3. Tests that failed before their fix

No failing test was removed or weakened. Each audit regression test was
first run against the unfixed code: either the original code, or the code
with the fix stashed (`git stash` of the source files only).

| Test | Failure before the fix |
| --- | --- |
| sandbox "AUDIT C1" | host canary file was uploaded as a coverage artifact |
| sandbox "AUDIT C2" | vitest hung (worker blocked on a FIFO) |
| audit-scheduler (H1, H2, H3, M5, M6, M8, M9, flaky budget…) | 7 of the first 10 failed |
| audit-scheduler H11 | `POST /jobs/:id/cancel` → 500 (`deadlock detected`) |
| audit-scheduler M8b | new event not delivered within 5 s (window stall) |
| audit-security (all 11 original) | 11/11 failed |
| audit-ai, integrations AUDIT P1/P2 | 4/4 failed |
| integrations AUDIT G1 | redelivery answered "duplicate"; no job |
| audit-storage S13 | the 2nd concurrent upload was accepted (no budget) |
| demo `rw_overlap` with the old reference patch | `rdata_stable` assertion fired at 105 ns |

## 4. Flakiness

`integrations.test.ts` failed in 1 of 4 consecutive runs, with two
order-dependent test bugs (T1 in the engineering audit). After the fix it
passed in 3 of 3 consecutive runs, and again in the final full run.

## 5. RTL bug injection (Phase 7)

Host Verilator (`--binary --timing --assert`), the final testbench, every
test plus `random` seeds 1–4 (OPS=400). Script and per-test results:
`docs/benchmarks/audit-2026-10-10/rtl-mutation/`.

| Design | Failing tests |
| --- | --- |
| original demo RTL (intentional bug) | `rw_overlap`, `random` 1–4 |
| old reference patch (registered address only) | `rw_overlap` (**latent bug, R1**) |
| new reference patch (RDATA registered) | none |

Mutants on top of the new reference design:

| Mutant | Detected by |
| --- | --- |
| write strobes ignored | wstrb, random 1–4 |
| WSTRB lanes reversed | wstrb, random 1–4 |
| write to ID returns OKAY | error_injection, random 1–4 |
| unaligned read returns OKAY | error_injection, random 1–3 |
| SCRATCH reset value wrong | reset, error_injection, rw_overlap, random 1–4 |
| BVALID dropped without BREADY | random 1–4 (assertion `bvalid_stable`) |
| RVALID dropped without RREADY | rw_overlap, random 1–4 |
| read decode ignores address bit 3 | all tests |
| write to DATA1 lands in DATA0 | smoke, wstrb, rw_overlap, random 1–4 |
| AWREADY not gated by the held address | **not detected**: testbench gap O3 (the master never has two AWs outstanding) |

Detection: 9 of 10 mutants.

Source-line accuracy: the analyzer cites the RTL driver at
`rtl/axil_regs.sv:131`, the exact line. The assertion is cited at
`tb/axil_checker.sv:52`, as Verilator reports it; that is the `else $error`
line, and the property starts at line 50.

Waveform evidence: in the demo E2E, the table shows `araddr` changing while
`rvalid=1, rready=0`.

Testbench note: in this testbench under Verilator 5.020, two concurrent
calls of the `idle()` task from a `fork … join` returned early (12 + 3
cycles elapsed in about 7). As a result, the first version of `rw_overlap`
passed vacuously. A standalone reproduction did **not** show the problem,
so its cause is not isolated. The test uses inline `repeat` loops instead.

## 6. AI analyzer evaluation (Phase 8)

Command: `npx tsx bench/ai-eval.ts`. Each case ran on a real worker in the
Docker sandbox; the output is `docs/benchmarks/ai-eval.json`.

- Clean baseline: 14/14 tasks passed.
- 12 cases: 11 seeded defects plus a syntax error. 11 were detected by the testbench.
- 28 analyses:
  - 3 correct
  - 25 abstained
  - 0 wrong (false-positive diagnoses)
  - 0 errors
  - 0 high-confidence wrong
- 5 of 28 analyses cite a location near the defect.

LLM providers were not evaluated (no credentials).

Prompt injection was tested through a stub LLM: delimiters in logs, file
names and commit messages, and patch scope. Redaction was tested with a
corpus of 15 secret formats and 5 benign RTL/log lines.

## 7. Infrastructure checks (Phase 5)

| Check | Result |
| --- | --- |
| 60 MB artifact round trip (sha256), Range 206/416 | passed (audit-storage) |
| Interrupted upload leaves no row or object; 413 over the limit | passed |
| Storage outage during a run; API restart; PostgreSQL restart; worker partition | passed (recovery.test.ts) |
| Compose: build, health, E2E, drain, API restart, backup/restore | see deployment-report.md |
| MinIO, AWS S3 | **BLOCKED** |

## 8. Not executed

| Item | Status |
| --- | --- |
| GitHub Actions CI | not run (no access) |
| Real GitHub App / OAuth | BLOCKED |
| Real LLM | BLOCKED |
| SMTP delivery | not run |
| gVisor | not available |
| Official-image Compose | BLOCKED |
| Kernel or container-escape testing | deliberately not attempted on a shared host (brief rule 14) |
