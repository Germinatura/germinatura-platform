import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";

const trackedFiles = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const binaryExtensions = new Set([
  ".docx", ".ico", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".woff", ".woff2", ".zip", ".gz", ".pdf",
]);

const secretRules = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["Supabase secret key", /sb_secret_[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9_]{20,}/],
  ["live payment key", /sk_live_[A-Za-z0-9_-]{16,}/],
  ["credentialed database URL", /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:'"`]+:[^\s@'"`]+@/i],
  [
    "server secret assignment",
    /(?:SUPABASE_SERVICE_ROLE_KEY|CLOUDFLARE_API_TOKEN|MERCADO_PAGO_ACCESS_TOKEN|PICPAY_CLIENT_SECRET|PICPAY_WEBHOOK_SECRET)\s*[:=]\s*["'`]?[A-Za-z0-9._-]{20,}/i,
  ],
];

const findings = [];

for (const file of trackedFiles) {
  if (!existsSync(file)) continue;
  const normalized = file.replaceAll("\\", "/");
  const name = basename(normalized);

  if (name.startsWith(".env") && name !== ".env.example") findings.push([file, "committed environment file"]);
  if (name === ".dev.vars") findings.push([file, "committed Wrangler secret file"]);
  if (normalized.split("/").includes(".wrangler")) findings.push([file, "committed Wrangler state"]);
  if (/(^|\/)(dump|backup|users)[^/]*\.(sql|json|zip|tar|gz)$/i.test(normalized)) findings.push([file, "dump or backup artifact"]);
  if (/\.(log|dump|bak|backup)$/i.test(name) || /\.sql\.gz$/i.test(name)) findings.push([file, "log, dump or backup artifact"]);
  if (/(^|\/)(db-debug|verification_output)[^/]*\.txt$/i.test(normalized) || /(^|\/)out\.json$/i.test(normalized)) {
    findings.push([file, "diagnostic artifact"]);
  }

  if (binaryExtensions.has(extname(name).toLowerCase())) continue;
  const content = readFileSync(file, "utf8");
  for (const [ruleName, pattern] of secretRules) {
    if (pattern.test(content)) findings.push([file, ruleName]);
  }
}

if (findings.length > 0) {
  for (const [file, rule] of findings) console.error(`${file}: ${rule}`);
  console.error(`Security scan failed with ${findings.length} finding(s). Matched values were not printed.`);
  process.exit(1);
}

console.log(`Security scan passed for ${trackedFiles.length} candidate file(s).`);
