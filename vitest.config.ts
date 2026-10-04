import { resolve, sep } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

// `@/` means the root of the app that imports it (apps/portal or apps/pdv), as in each app's tsconfig.
function appAlias(): Plugin {
  const apps = ["portal", "pdv"].map((name) => ({ marker: `${sep}apps${sep}${name}${sep}`, root: resolve(__dirname, "apps", name) }));
  return {
    name: "germinatura-app-alias",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!source.startsWith("@/") || !importer) return null;
      const app = apps.find(({ marker }) => resolve(importer).includes(marker));
      return app ? this.resolve(resolve(app.root, source.slice(2)), importer, { ...options, skipSelf: true }) : null;
    },
  };
}

export default defineConfig({
  plugins: [appAlias()],
  test: {
    include: ["packages/**/*.test.ts", "apps/jobs/**/*.test.ts", "apps/pdv/**/*.test.ts", "apps/portal/**/*.test.ts", "tests/load/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**", "**/dist/**"],
    environment: "node",
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
