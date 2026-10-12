# VerifyCloud engineering audit — 2026-10-08 … 2026-10-10

Branch `audit/2026-10-08` (base `8fdc165`). Nothing was pushed, merged,
deployed publicly or run on paid infrastructure.

| Deliverable | File |
| --- | --- |
| A. Verified repository | `verifycloud.bundle` (all refs) and `verifycloud.zip` (audit branch tree) |
| B. Engineering audit, file by file, with change log | [engineering-audit.md](engineering-audit.md) |
| C. Test report | [test-report.md](test-report.md) |
| D. Security report | [security-report.md](security-report.md) |
| E. Benchmark report | [benchmark-report.md](benchmark-report.md) |
| F. Deployment report | [deployment-report.md](deployment-report.md) |
| G. Requirements matrix | [requirements-matrix.md](requirements-matrix.md) |
| H. Production-readiness decision | below |
| I. Resume evidence (verified only) | [resume-evidence.md](resume-evidence.md) |
| J. Handoff and roadmap | [handoff.md](handoff.md) |

## H. Production-readiness decision: **INTERNALLY VALIDATED BETA**

Why not lower: the core system works end to end on real components. That
covers PostgreSQL 16, the real Docker sandbox, real Verilator 5.020, the
real worker, the real API and the browser UI. It has been tested by
correctness, adversarial, failure-injection and security suites (all
passing on the final commit), a Compose deployment with stand-in base
images, a browser E2E run, a backup/restore drill and repeated benchmarks.
All Critical and High defects found were fixed with regression tests.

Why not higher, since the brief says not to call the system production-ready
while critical integration, security or recovery checks remain unverified:

- **Real GitHub** (App, OAuth, checks, webhooks) was never exercised: no credentials or network.
- **Official-image Compose** (`docker compose up --build` from a clean checkout) and **MinIO** are BLOCKED: the registries are unreachable.
- **CI** was never executed.
- **LLM providers** were never exercised (no API key). Model behaviour under prompt injection is unknown.
- **Isolation** is Docker/runc only; gVisor/VM isolation is untested. Docker is not a perfect boundary.
- Performance was measured on a single 2-vCPU host only.

To reach CONTROLLED EXTERNAL BETA: complete the first four rows of the table
in [handoff.md](handoff.md) (official Compose + MinIO, real GitHub, CI, and
an LLM if AI is offered externally), and run workers on dedicated hosts or
VMs.
