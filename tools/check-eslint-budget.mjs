import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ESLint } from "eslint";

const budget = JSON.parse(await readFile(new URL("../quality/legacy-eslint-budget.json", import.meta.url), "utf8"));
let failed = false;

for (const [workspace, maximumWarnings] of Object.entries(budget)) {
  const cwd = resolve(workspace);
  const eslint = new ESLint({ cwd });
  const results = await eslint.lintFiles(["."]);
  const errors = results.reduce((total, result) => total + result.errorCount, 0);
  const warnings = results.reduce((total, result) => total + result.warningCount, 0);
  console.log(`${workspace}: ${errors} error(s), ${warnings}/${maximumWarnings} warning(s)`);
  if (errors > 0 || warnings > maximumWarnings) failed = true;
}

if (failed) process.exitCode = 1;
