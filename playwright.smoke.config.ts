import { defineConfig } from "@playwright/test";

// Automated PDV smokes (H1/H2/D) against staging (CI job after the deploy) or the local apps (SMOKE_TARGET=local).
// No web server is started; synthetic data and real sessions only (tests/staging-smoke).
export default defineConfig({
  testDir: "./tests/staging-smoke/specs",
  testMatch: /.*\.smoke\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  retries: 0,
  expect: { timeout: 20_000 },
  globalSetup: "./tests/staging-smoke/global-setup.ts",
  globalTeardown: "./tests/staging-smoke/global-teardown.ts",
  reporter: [["list"], ["json", { outputFile: "smoke-results.json" }]],
  // Staging traces would hold the synthetic password of the login request: never recorded there.
  use: { trace: process.env.SMOKE_TARGET === "staging" ? "off" : "retain-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
