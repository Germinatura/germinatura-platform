import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
// The load harness guard: only the Germinatura staging Workers and the matching Supabase project are accepted.
// @ts-expect-error -- plain ESM module without types
import { stagingTarget } from "../load/lib/guard.mjs";
// @ts-expect-error -- plain ESM module without types
import { stagingSql } from "../load/lib/staging-sql.mjs";

export interface SmokeTarget { name: "staging" | "local"; portal: string; pdv: string; sql: (query: string) => Promise<Array<Record<string, unknown>>> }

/**
 * Where the smokes run. "staging" (the CI job): the staging Workers and the staging database through the Supabase
 * Management API, refusing any other host. "local": the apps on 127.0.0.1 and the local Supabase container of this
 * checkout, to validate the smokes before they reach staging. Nothing else is accepted.
 */
export function smokeTarget(env: NodeJS.ProcessEnv = process.env): SmokeTarget {
  if (env.SMOKE_TARGET === "staging") {
    const target = stagingTarget({ ...env, LOAD_TARGET: "staging" }) as { portal: string; pdv: string };
    return { name: "staging", portal: target.portal, pdv: target.pdv, sql: stagingSql(target) as SmokeTarget["sql"] };
  }
  if (env.SMOKE_TARGET === "local") {
    const portal = env.PORTAL_URL ?? "http://127.0.0.1:3000";
    const pdv = env.PDV_URL ?? "http://127.0.0.1:3001";
    for (const url of [portal, pdv]) if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error(`Alvo local recusado: ${url}`);
    const projectId = readFileSync("supabase/config.toml", "utf8").match(/^project_id\s*=\s*"([^"]+)"/m)?.[1];
    if (!projectId) throw new Error("supabase/config.toml sem project_id");
    const container = `supabase_db_${projectId}`;
    execFileSync("docker", ["inspect", container], { stdio: "ignore" });
    const sql = async (query: string) => {
      const result = spawnSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-X", "-q", "-A", "-t", "-c",
        `select coalesce(json_agg(row_to_json(result)), '[]'::json) from (${query.replace(/;\s*$/, "")}) result`], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
      return JSON.parse(result.stdout.trim() || "[]") as Array<Record<string, unknown>>;
    };
    return { name: "local", portal, pdv, sql };
  }
  throw new Error("SMOKE_TARGET=staging ou SMOKE_TARGET=local é obrigatório.");
}

/** Runs a script (several statements, no result), e.g. the fixtures. */
export async function runScript(target: SmokeTarget, script: string) {
  if (target.name === "staging") { await target.sql(script); return; }
  const projectId = readFileSync("supabase/config.toml", "utf8").match(/^project_id\s*=\s*"([^"]+)"/m)?.[1];
  const result = spawnSync("docker", ["exec", "-i", `supabase_db_${projectId}`, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-X", "-q"], { input: script, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}
