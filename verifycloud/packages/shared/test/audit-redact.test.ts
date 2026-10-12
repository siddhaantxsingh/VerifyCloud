// Redaction corpus (audit): what the pattern layer catches, and that ordinary
// simulator output and RTL are left alone. Pattern detection is a safety net;
// project secrets are redacted exactly (known-secret layer) regardless of format.
import { describe, expect, it } from "vitest";

import { redact } from "../src/redact.js";

const SECRETS: Record<string, string> = {
  github_pat: "token ghp_" + "a".repeat(36),
  github_fine_grained: "github_pat_" + "B".repeat(30),
  aws_access_key: "AKIAIOSFODNN7EXAMPLE",
  aws_secret_assignment: "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  private_key: "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
  url_credentials: "https://user:hunter22@example.com/x",
  openai_key: "sk-proj-" + "c".repeat(30),
  anthropic_style_key: "sk-ant-api03-" + "d".repeat(40),
  slack: "xoxb-1234567890-abcdef",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  bearer: "Authorization: Bearer abcdefghijklmnop1234",
  password_assignment: 'DB_PASSWORD="hunter2pass"',
  gitlab: "glpat-" + "e".repeat(20),
  google_api_key: "AIza" + "f".repeat(35),
  azure_connection_string: "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=" + "g".repeat(40) + "==",
};

const BENIGN = [
  "VC_CHECK FAIL read addr=0x08: RDATA=0xff7fffff expected 0x000000ff",
  "[75000] %Error: axil_checker.sv:52: Assertion failed in TOP.tb_top.chk.rdata_stable",
  "  logic [31:0] secret_q;  assign key_valid = token_in & ~busy;",
  "parameter int SECRET_KEY_W = 128;",
  "VC_SIM_END finish=1 error=0 time=100 timeunit=-12",
];

describe("redaction corpus", () => {
  for (const [name, text] of Object.entries(SECRETS))
    it(`redacts ${name}`, () => {
      const r = redact(`log line before\n${text}\nlog line after`);
      expect(r.count, r.text).toBeGreaterThan(0);
      const secretPart = name === "url_credentials" ? "hunter22" : text.replace(/^(token |Authorization: Bearer |aws_secret_access_key = |DB_PASSWORD=)/, "").slice(-12);
      expect(r.text).not.toContain(secretPart);
    });

  it("leaves ordinary simulator output and RTL unchanged", () => {
    for (const line of BENIGN) expect(redact(line)).toEqual({ text: line, count: 0, kinds: [] });
  });

  it("known secrets are redacted whatever their format", () => {
    expect(redact("license 27000@lic.corp.example", ["27000@lic.corp.example"]).text).toBe("license [REDACTED:secret]");
  });
});
