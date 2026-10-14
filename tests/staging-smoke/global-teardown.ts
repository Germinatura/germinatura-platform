import { rmSync } from "node:fs";
import { smokeTarget } from "./target";
import { readState, statePath } from "./state";

/** Retires the run (idempotent) and fails when anything the run created is still active. */
export default async function globalTeardown() {
  const target = smokeTarget();
  let run: string;
  try { run = readState().fixture.run; } catch { return; }
  await target.sql(`select smoketest.retire('${run}') as retired`);
  const [row] = await target.sql(`select smoketest.leftovers('${run}') as leftovers`);
  const leftovers = (typeof row.leftovers === "string" ? JSON.parse(row.leftovers) : row.leftovers) as Record<string, number>;
  console.log(`[smoke] sobras da execução ${run}: ${JSON.stringify(leftovers)}`);
  rmSync(statePath(), { force: true });
  const dirty = Object.entries(leftovers).filter(([, count]) => Number(count) !== 0);
  if (dirty.length > 0) throw new Error(`Fixtures do smoke não foram totalmente retiradas: ${JSON.stringify(Object.fromEntries(dirty))}`);
}
