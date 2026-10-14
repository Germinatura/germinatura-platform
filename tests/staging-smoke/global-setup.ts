import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { runScript, smokeTarget } from "./target";
import { statePath, type SmokeFixture } from "./state";

/** Installs the fixtures, retires runs an interrupted job left behind and prepares this run's synthetic data. */
export default async function globalSetup() {
  const target = smokeTarget();
  const run = randomBytes(6).toString("hex").slice(0, 10).replace(/^[0-9]/, "s");
  const password = `Smk-${randomBytes(18).toString("base64url")}9a`;
  await runScript(target, readFileSync("tests/staging-smoke/fixtures.sql", "utf8"));
  const stale = await target.sql("select smoketest.retire_stale() as retired");
  const [row] = await target.sql(`select smoketest.prepare('${run}', '${password.replaceAll("'", "''")}') as fixture`);
  const fixture = (typeof row.fixture === "string" ? JSON.parse(row.fixture) : row.fixture) as SmokeFixture;
  writeFileSync(statePath(), JSON.stringify({ fixture, password }), { mode: 0o600 });
  console.log(`[smoke] ${target.name}: execução ${run}, turma ${fixture.cohort.slug}, execuções antigas retiradas: ${JSON.stringify(stale[0]?.retired ?? 0)}`);
}
