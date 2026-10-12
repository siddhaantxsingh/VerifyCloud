import { defineConfig } from "@playwright/test";

// Runs against an already running deployment (docker compose up, or
// scripts/dev-local.sh): E2E_BASE_URL, with the demo seeded and a worker.
export default defineConfig({
  testDir: "e2e",
  timeout: 300_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8080",
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
