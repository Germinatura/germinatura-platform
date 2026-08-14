import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: process.env.PORTAL_URL ?? "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: process.env.PLAYWRIGHT_EXTERNAL_SERVERS
    ? undefined
    : [
        {
          command: "pnpm --filter @germinatura/portal dev",
          url: "http://127.0.0.1:3000/api/v1/health",
          reuseExistingServer: !process.env.CI,
        },
        {
          command: "pnpm --filter @germinatura/pdv dev",
          url: "http://127.0.0.1:3001/api/v1/health",
          reuseExistingServer: !process.env.CI,
        },
      ],
});
