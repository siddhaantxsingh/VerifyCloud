#!/usr/bin/env bash
# Called by action.yml. Inputs arrive as environment variables (never
# interpolated into the script), the token only via VERIFYCLOUD_TOKEN.
set -euo pipefail
: "${VC_CLI:?}" "${VC_PROJECT:?}" "${VERIFYCLOUD_API_URL:?}" "${VERIFYCLOUD_TOKEN:?}"
echo "::add-mask::${VERIFYCLOUD_TOKEN}"
args=(run --project "$VC_PROJECT" --dir "${VC_DIR:-.}" --json)
[[ -n "${VC_REGRESSION:-}" ]] && args+=(--regression "$VC_REGRESSION")
[[ "${VC_WAIT:-true}" == "true" ]] && args+=(--wait)
out="$(mktemp)"
set +e
node "$VC_CLI" "${args[@]}" >"$out"
code=$?
set -e
summary="$(node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const j = r.job;
  const url = r.url || (process.env.VERIFYCLOUD_API_URL.replace(/\/+$/, "") + "/runs/" + j.id);
  // values come from the API: strip newlines so they cannot inject extra output lines (audit)
  const clean = (v) => String(v ?? "").replace(/[\r\n]/g, "");
  const lines = [`job-id=${clean(j.id)}`, `state=${clean(r.tasks ? j.state : "")}`, `url=${clean(url)}`];
  require("fs").appendFileSync(process.env.GITHUB_OUTPUT || "/dev/null", lines.join("\n") + "\n");
  const s = j.summary || {};
  const failed = (r.tasks || []).filter((t) => t.kind === "test" && t.state !== "PASSED").map((t) => `| \`${t.test_name}\` | ${t.seed} | ${t.state} |`);
  let md = `### VerifyCloud: ${j.state}\n\n[Run #${j.number}](${url}) — passed ${s.passed ?? 0}, failed ${s.failed ?? 0}\n`;
  if (failed.length) md += `\n| test | seed | state |\n|---|---|---|\n${failed.slice(0, 50).join("\n")}\n`;
  process.stdout.write(md);
' "$out" 2>/dev/null || true)"
if [[ -n "$summary" && -n "${GITHUB_STEP_SUMMARY:-}" ]]; then echo "$summary" >>"$GITHUB_STEP_SUMMARY"; fi
[[ -n "$summary" ]] && echo "$summary"
rm -f "$out"
exit "$code"
