# Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| API exits with `unsafe production configuration` | `NODE_ENV=production` without HTTPS `PUBLIC_URL`, `COOKIE_SECURE=true`, `SECRET_ENCRYPTION_KEY` or a strong worker token | set them (docs/deployment.md) or use `NODE_ENV=development` locally |
| `/ready` 503, `objectStorage: false` | bucket endpoint unreachable or wrong credentials | check `S3_*`; the API creates the bucket if missing |
| Jobs stay `QUEUED` | no worker online, worker capacity smaller than the task's `cpu`/`memory_mb`, or org/project quota reached | Workers page; `WORKER_CPUS`/`WORKER_MEMORY_MB`; plan quotas; `resources:` in the config |
| Build `RESOURCE_EXCEEDED` quickly | compile memory too small | raise `resources.compile_memory_mb` (default max(memory_mb, 2048)) |
| Worker logs `docker is not available` | Docker socket not mounted / no permission | mount `/var/run/docker.sock`; run the worker as a user that can use it |
| Sandbox fails with `no such file` for run directories | `WORK_DIR` differs between host and worker container | mount the same absolute path at the same location |
| Worker logs `registration failed; retrying` | API not reachable yet | it retries with backoff; check `API_URL` |
| Worker exits with `worker registration failed: HTTP 401` | wrong `WORKER_REGISTRATION_TOKEN` | use the API's value |
| Tests `TIMED_OUT` | `$finish` never reached, or limit too low | check the testbench end condition; `timeout_seconds` |
| Test `FAILED` with exit code 3 | simulation ended without `$finish` (no more events) | add `$finish`; check for deadlocked `wait`s |
| Test `RESOURCE_EXCEEDED` "output flood" | testbench prints in a tight loop | reduce `$display` volume |
| `%Error-…` about a flag | flag forbidden by VerifyCloud (controls outputs/harness) | remove it; see docs/simulator-adapters.md |
| Assertion never fires although it should | Verilator 5.020 SVA subset (e.g. `and` of implications) | split the property |
| Coverage shows small totals | Verilator line coverage counts blocks, not lines | expected |
| No waveform on a failed test | `waveform: never`, or VCD over `MAX_WAVEFORM_BYTES` | change the setting / limit |
| Analysis says "insufficient evidence" | failure pattern not covered by the rule-based analyzer and no LLM configured | follow the listed next steps; optionally enable a provider |
| GitHub pushes do not start runs | installation not claimed, repository not connected, branch differs from the project branch, webhook secret mismatch (401 in API log) | Organization settings → installations; Project settings → repository |
| CLI `refusing to send a token over plain http` | `--api http://remote-host` | use https (http is allowed for localhost only) |
| CLI exit codes | 0 success, 1 tests failed, 2 usage/config/auth error, 3 timeout/resources/cancelled/infrastructure | — |

Logs to collect for a bug report: API log lines with the request id from the
error response, worker log lines for the task id, the task's log artifact.
