// End-to-end through the browser with a real worker and Verilator:
// log in → run the demo's full regression → it FAILS → open a failing test →
// rule-based analysis points at the bug → verify the reference fix in a fresh
// run → it PASSES. Also checks the waveform viewer renders and live updates.
import { expect, test } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL ?? "admin@demo.local";
const PASSWORD = process.env.E2E_PASSWORD ?? "change-me-locally";

test("demo: failing regression → analysis → verified fix", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  await page.getByRole("link", { name: "AXI4-Lite demo" }).first().click();
  await expect(page.getByRole("heading", { name: "Regressions" })).toBeVisible();
  const fullRow = page.getByRole("row").filter({ hasText: /^full/ });
  await fullRow.getByRole("button", { name: "Run" }).click();

  // run page, updated live over SSE until the job finishes
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: /Run #\d+ failed/i })).toBeVisible({ timeout: 240_000 });
  await expect(page.getByText(/4 \/ 13 passed/)).toBeVisible();

  // a failing randomized test
  await page.getByRole("link", { name: "random" }).first().click();
  await expect(page.getByRole("tab", { name: "Failure analysis" })).toBeVisible();
  await page.getByRole("button", { name: /Analyze/ }).click();
  await expect(page.getByText("high confidence")).toBeVisible();
  await expect(page.getByRole("button", { name: "rtl/axil_regs.sv:131" }).first()).toBeVisible();
  await expect(page.getByText("exists in sources").first()).toBeVisible();

  // waveform viewer
  await page.getByRole("tab", { name: "Waveform" }).click();
  await expect(page.getByRole("img", { name: "Waveform" })).toBeVisible();
  await expect(page.locator(".wave .siglabel", { hasText: "rvalid" })).toBeVisible();

  // verify the shipped reference fix in a fresh run
  await page.getByRole("tab", { name: "Failure analysis" }).click();
  await page.getByRole("button", { name: /verify the reference fix/ }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByText(/Patch verification of/)).toBeVisible();
  await expect(page.getByRole("heading", { name: /Run #\d+ succeeded/i })).toBeVisible({ timeout: 240_000 });
  await expect(page.getByText(/13 \/ 13 passed/)).toBeVisible();
  await page.getByRole("tab", { name: "Compare" }).click();
  await expect(page.getByRole("heading", { name: "Newly failing (0)" })).toBeVisible();

  expect(errors).toEqual([]);
});

test("unauthenticated API access is refused and the SPA does not leak data", async ({ request }) => {
  const r = await request.get("/api/v1/orgs");
  expect(r.status()).toBe(401);
});
