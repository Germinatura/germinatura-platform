import { spawnSync } from "node:child_process";
import { join } from "node:path";

const command = join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "supabase.cmd" : "supabase",
);
const result = spawnSync(command, process.argv.slice(2), {
  env: {
    ...process.env,
    // Avoid writing CLI telemetry state outside the repository in sandboxed/CI runs.
    DO_NOT_TRACK: "1",
  },
  shell: process.platform === "win32",
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
