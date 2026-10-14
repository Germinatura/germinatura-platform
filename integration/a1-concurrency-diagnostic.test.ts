import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

// A1 diagnostic (never merged): repeats the racing-materialization scenario of signup-identity-concurrency and records,
// for every call that is not 200, only safe facts: iteration, call, HTTP status, error code/message and the time since
// the verify. Never the OTP, a token, a cookie or an e-mail address.
function local() {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const value = (key: string) => status.match(new RegExp(`^${key}="?([^"\r\n]+)"?$`, "m"))?.[1];
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? value("API_URL");
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? value("PUBLISHABLE_KEY");
  const mailbox = value("MAILPIT_URL") ?? value("INBUCKET_URL");
  if (!url || !key || !mailbox) throw new Error("Local Supabase required");
  return { url, key, mailbox };
}
const { url, key, mailbox } = local();
const safe = (text: string | null | undefined) => (text ?? "").replace(/[\w.+-]+@[\w.-]+/g, "<email>").replace(/eyJ[\w.-]+/g, "<jwt>").replace(/\b\d{6}\b/g, "<code>").slice(0, 160);

async function auth(path: string, body: Record<string, unknown>) {
  return fetch(`${url}/auth/v1/${path}`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function latestCode(email: string, after: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const body = await (await fetch(`${mailbox}/api/v1/messages`)).json() as { messages: Array<{ To: Array<{ Address: string }>; Snippet: string; Created: string }> };
    const message = body.messages.filter((item) => item.To.some((to) => to.Address === email) && item.Created > after).sort((l, r) => r.Created.localeCompare(l.Created))[0];
    const code = message?.Snippet.match(/\b\d{6}\b/)?.[0];
    if (code) return code;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("no code");
}

it("A1 diagnostic: which concurrent call is not 200, and why", async () => {
  const failures: Array<Record<string, unknown>> = [];
  const iterations = 12;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const email = `a1.diag.${randomUUID().slice(0, 8)}@institutojef.org.br`;
    const sent = new Date().toISOString();
    const otp = await auth("otp", { email, create_user: true });
    if (otp.status !== 200) { failures.push({ iteration, call: "otp", status: otp.status, error: safe(await otp.text()) }); continue; }
    const code = await latestCode(email, sent);
    const verifiedAt = Date.now();
    const verifies = await Promise.all([1, 2].map(() => auth("verify", { type: "email", email, token: code })));
    const tokens: string[] = [];
    for (const [index, response] of verifies.entries()) {
      const body = await response.json().catch(() => null) as { access_token?: string; error_code?: string; msg?: string } | null;
      if (response.ok && body?.access_token) tokens.push(body.access_token);
      else failures.push({ iteration, call: `verify#${index}`, status: response.status, error: safe(body?.error_code ?? body?.msg), expected: "one of two may lose" });
    }
    const results = await Promise.all(tokens.flatMap((token, session) => [1, 2, 3].map(async (call) => {
      const started = Date.now() - verifiedAt;
      const response = await fetch(`${url}/rest/v1/rpc/materialize_my_signup_identity`, { method: "POST",
        headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ p_correlation_id: randomUUID() }) });
      const body = await response.json().catch(() => null) as { code?: string; message?: string } | null;
      return { session, call, status: response.status, msSinceVerify: started, error: response.ok ? null : safe(`${body?.code ?? ""} ${body?.message ?? ""}`) };
    })));
    for (const result of results) if (result.status !== 200) failures.push({ iteration, ...result });
  }
  const unexpected = failures.filter((failure) => failure.expected === undefined);
  console.log(`A1 DIAGNOSTIC ${JSON.stringify({ iterations, unexpected: unexpected.length, failures })}`);
  expect(unexpected).toEqual([]);
}, 600_000);
