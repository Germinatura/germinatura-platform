import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/jobs/**/*.test.ts", "apps/pdv/**/*.test.ts"],
    environment: "node",
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
