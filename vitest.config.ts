import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/jobs/**/*.test.ts", "apps/pdv/**/*.test.ts", "apps/portal/**/*.test.ts", "tests/load/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**", "**/dist/**"],
    environment: "node",
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
