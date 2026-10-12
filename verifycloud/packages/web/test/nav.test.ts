import { describe, expect, it } from "vitest";

import { safeNext } from "../src/nav";

const O = "https://vc.example.com";
describe("post-login redirect (audit S10)", () => {
  it("keeps same-origin paths", () => {
    expect(safeNext("/runs/abc?x=1#t", O)).toBe("/runs/abc?x=1#t");
    expect(safeNext(null, O)).toBe("/");
  });
  it("refuses anything that resolves to another origin", () => {
    for (const n of ["//evil.com", "/\\evil.com", "/%09/evil.com".replace("%09", "\t"), "https://evil.com/x", "javascript:alert(1)", "\\\\evil.com"]) expect(safeNext(n, O), n).toBe("/");
  });
});
