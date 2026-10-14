// Local-only database access shared by the upgrade check and the cohort spikes. Fails closed: it never accepts a
// connection string and only talks to the local Supabase container through `docker exec`.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function fail(tool, message) {
  console.error(`${tool} recusado: ${message}`);
  process.exit(1);
}

export function localTarget(root, tool) {
  if (process.env.NODE_ENV === "production") fail(tool, "NODE_ENV=production.");
  for (const name of ["SUPABASE_ACCESS_TOKEN", "SUPABASE_PROJECT_REF", "SUPABASE_DB_PASSWORD"]) {
    if (process.env[name]) fail(tool, `a variável ${name} indica um projeto Supabase remoto.`);
  }
  const config = readFileSync(join(root, "supabase", "config.toml"), "utf8");
  const projectId = config.match(/^project_id\s*=\s*"([^"]+)"/m)?.[1];
  if (!projectId) fail(tool, "supabase/config.toml sem project_id.");
  let status;
  try {
    status = execFileSync(process.execPath, [join(root, "tools", "run-supabase.mjs"), "status", "-o", "env"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    fail(tool, "o Supabase local não está rodando (pnpm supabase:start).");
  }
  const value = (key) => status.match(new RegExp(`^${key}="?([^"\\r\\n]+)"?$`, "m"))?.[1];
  const isLocal = (url) => { try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname); } catch { return false; } };
  if (!isLocal(value("API_URL")) || !isLocal(value("DB_URL"))) fail(tool, "o Supabase em uso não é local.");
  const container = `supabase_db_${projectId}`;
  const inspect = spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", container], { encoding: "utf8" });
  if (inspect.status !== 0 || inspect.stdout.trim() !== "true") fail(tool, `contêiner local ${container} não encontrado.`);
  return { container, projectId, apiUrl: value("API_URL"), anonKey: value("ANON_KEY") ?? value("PUBLISHABLE_KEY") };
}

export function psql(target, sql, extra = [], { database = "postgres", allowFailure = false } = {}) {
  const result = spawnSync("docker", ["exec", "-i", target.container, "psql", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-A", "-t", ...extra],
    { input: sql, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure) throw new Error(result.stderr || result.stdout);
  return allowFailure ? { status: result.status, stdout: result.stdout, stderr: result.stderr } : result.stdout.trim();
}

export function run(root, label, command, args, { env = {}, capture = false, allowFailure = false } = {}) {
  console.log(`\n▶ ${label}`);
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...env },
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", shell: process.platform === "win32" && command !== process.execPath,
  });
  if (result.status !== 0 && !allowFailure) throw new Error(`${label} falhou (código ${result.status})${capture ? `\n${result.stderr}` : ""}`);
  return { ms: Date.now() - started, status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
