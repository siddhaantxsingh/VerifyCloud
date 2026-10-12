// Secret redaction for logs, error messages and AI context.
//
// Two layers: exact replacement of secrets VerifyCloud knows (project secrets,
// tokens it issued), and pattern-based detection of well-known credential
// formats. Pattern detection is a safety net, not a guarantee.

export interface Redaction {
  text: string;
  count: number;
  kinds: string[];
}

const PATTERNS: [string, RegExp][] = [
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g],
  ["url_credentials", /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@\/]+:[^\s@\/]+@/gi],
  ["aws_access_key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["verifycloud_token", /\bvc_(?:pat|key|wrk|sess)_[A-Za-z0-9_-]{16,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ["openai_key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ["bearer", /\b(Bearer)\s+[A-Za-z0-9._~+\/-]{16,}=*/g],
  ["gitlab_token", /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  // key names may carry a prefix/suffix (aws_secret_access_key, DB_PASSWORD, AccountKey)
  ["assignment", /\b((?:[a-z0-9]+[_-])*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|account[_-]?key|private[_-]?key)(?:[_-][a-z0-9]+)*\s*[:=]\s*)(["']?)[^\s"']{6,}\2/gi],
];

export function redact(input: string, knownSecrets: string[] = []): Redaction {
  let text = input;
  let count = 0;
  const kinds = new Set<string>();
  for (const s of knownSecrets) {
    if (!s || s.length < 4) continue;
    const parts = text.split(s);
    if (parts.length > 1) {
      count += parts.length - 1;
      kinds.add("known_secret");
      text = parts.join("[REDACTED:secret]");
    }
  }
  for (const [kind, re] of PATTERNS) {
    text = text.replace(re, (...m: string[]) => {
      count++;
      kinds.add(kind);
      if (kind === "url_credentials") return `${m[1]}[REDACTED]@`;
      if (kind === "bearer") return `${m[1]} [REDACTED]`;
      if (kind === "assignment") return `${m[1]}[REDACTED]`;
      return `[REDACTED:${kind}]`;
    });
  }
  return { text, count, kinds: [...kinds] };
}
