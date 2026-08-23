import { defineConfig } from "@playwright/test";
import { execSync } from "node:child_process";

function localSupabasePublicEnvironment(): Record<string, string> {
  const configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const configuredKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (configuredUrl && configuredKey) {
    return {
      NEXT_PUBLIC_SUPABASE_URL: configuredUrl,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: configuredKey,
    };
  }

  const status = execSync("pnpm exec supabase status -o env", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const values = Object.fromEntries(
    status.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^([A-Z_]+)="?(.*?)"?$/);
      return match ? [[match[1], match[2]]] : [];
    }),
  );
  const url = values.API_URL;
  const publishableKey = values.PUBLISHABLE_KEY;
  if (!url || !publishableKey) {
    throw new Error("Supabase local iniciado, mas sem URL/chave publica para o E2E");
  }

  return {
    NEXT_PUBLIC_SUPABASE_URL: url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
  };
}

const localServerEnvironment = process.env.PLAYWRIGHT_EXTERNAL_SERVERS
  ? undefined
  : localSupabasePublicEnvironment();

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  timeout: 60_000,
  retries: process.env.CI ? 2 : 0,
  expect: { timeout: 15_000 },
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
          env: localServerEnvironment,
          reuseExistingServer: !process.env.CI,
        },
        {
          command: "pnpm --filter @germinatura/pdv dev",
          url: "http://127.0.0.1:3001/api/v1/health",
          env: localServerEnvironment,
          reuseExistingServer: !process.env.CI,
        },
      ],
});
