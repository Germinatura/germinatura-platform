import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// A1 against the real Auth service and a second database session: a code request is only a technical identity, the
// valid code creates exactly one domain user even under concurrency, and the purge never races a confirmation.
function local() {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const value = (key: string) => status.match(new RegExp(`^${key}="?([^"\\r\\n]+)"?$`, "m"))?.[1];
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? value("API_URL");
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? value("PUBLISHABLE_KEY");
  const serviceKey = value("SERVICE_ROLE_KEY");
  const mailbox = value("MAILPIT_URL") ?? value("INBUCKET_URL");
  if (!url || !key || !serviceKey || !mailbox || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error("Local Supabase required");
  // Only the local container, never a connection string (same rule as tools/upgrade-check/local.mjs).
  const projectId = readFileSync("supabase/config.toml", "utf8").match(/^project_id\s*=\s*"([^"]+)"/m)?.[1];
  if (!projectId) throw new Error("supabase/config.toml without project_id");
  return { url, key, serviceKey, mailbox, container: `supabase_db_${projectId}` };
}

const psqlArgs = (container: string) => ["exec", "-i", container, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-X", "-q", "-A", "-t"];
function sql(query: string) {
  const result = spawnSync("docker", psqlArgs(local().container), { input: query, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
/** A second session that runs while the test does other things; resolves with its output (or its error). */
function sqlInBackground(query: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("docker", psqlArgs(local().container));
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr }));
    child.stdin.end(query);
  });
}

/** Waits until a background session is really inside its pg_sleep (so it already holds what it locked). */
async function sleeping(marker: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (sql(`select count(*) from pg_stat_activity where wait_event = 'PgSleep' and query like '%${marker}%' and pid <> pg_backend_pid()`) !== "0") return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`background session ${marker} never started`);
}

async function auth(path: string, body: Record<string, unknown>, token?: string) {
  const { url, key } = local();
  return fetch(`${url}/auth/v1/${path}`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${token ?? key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function latestCode(email: string, after: string) {
  const { mailbox } = local();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const body = await (await fetch(`${mailbox}/api/v1/messages`)).json() as { messages: Array<{ To: Array<{ Address: string }>; Snippet: string; Created: string }> };
    const message = body.messages.filter((item) => item.To.some((to) => to.Address === email) && item.Created > after)
      .sort((left, right) => right.Created.localeCompare(left.Created))[0];
    const code = message?.Snippet.match(/\b\d{6}\b/)?.[0];
    if (code) return code;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no code for ${email}`);
}
async function rpc(name: string, body: Record<string, unknown>, token: string) {
  const { url, key } = local();
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
const domainRows = (email: string) => sql(`select (select count(*) from public.profiles p join auth.users u on u.id = p.id where u.email = '${email}')
  || ',' || (select count(*) from public.user_cohorts m join auth.users u on u.id = m.user_id where u.email = '${email}')
  || ',' || (select count(*) from cohort_data.user_roles r join auth.users u on u.id = r.user_id where u.email = '${email}')`);

it("a code request is only technical; a wrong or an expired code creates nobody", async () => {
  const email = `a1.tentativa.${randomUUID().slice(0, 8)}@institutojef.org.br`;
  const sent = new Date().toISOString();
  expect((await auth("otp", { email, create_user: true })).status).toBe(200);
  expect(sql(`select count(*) from auth.users where email = '${email}'`)).toBe("1");
  expect(domainRows(email)).toBe("0,0,0");
  // Name and username sent straight to Auth (as a fixture would carry them) still create nobody.
  const forged = `a1.forjado.${randomUUID().slice(0, 8)}@institutojef.org.br`;
  expect((await auth("otp", { email: forged, create_user: true, data: { name: "Pessoa Forjada", username: `forjado.${randomUUID().slice(0, 6)}` } })).status).toBe(200);
  expect(domainRows(forged)).toBe("0,0,0");
  const code = await latestCode(email, sent);
  expect((await auth("verify", { type: "email", email, token: code === "000000" ? "111111" : "000000" })).ok).toBe(false);
  expect(domainRows(email)).toBe("0,0,0");
  // The code's validity is counted from when it was sent: an hour later it has expired.
  sql(`update auth.users set recovery_sent_at = now() - interval '1 hour', confirmation_sent_at = now() - interval '1 hour' where email = '${email}'`);
  expect((await auth("verify", { type: "email", email, token: code })).ok).toBe(false);
  expect(domainRows(email)).toBe("0,0,0");
});

it("two verifies of the same valid code and racing materializations create exactly one domain user", async () => {
  const email = `a1.corrida.${randomUUID().slice(0, 8)}@institutojef.org.br`;
  const sent = new Date().toISOString();
  expect((await auth("otp", { email, create_user: true })).status).toBe(200);
  const code = await latestCode(email, sent);
  const verifies = await Promise.all([1, 2].map(() => auth("verify", { type: "email", email, token: code })));
  const sessions = await Promise.all(verifies.filter((response) => response.ok).map(async (response) => (await response.json() as { access_token: string }).access_token));
  expect(sessions.length).toBeGreaterThanOrEqual(1);
  expect(domainRows(email)).toBe("0,0,0");
  const results = await Promise.all(sessions.flatMap((token) => [1, 2, 3].map(() => rpc("materialize_my_signup_identity", { p_correlation_id: randomUUID() }, token))));
  // DIAGNOSTIC (never merged): safe facts of every call that is not 200 (status and error code/message only).
  const notOk = results.filter((result) => result.status !== 200).map((result) => ({ status: result.status,
    code: JSON.stringify(result.body.code ?? null), message: JSON.stringify(result.body.message ?? null).replace(/[\w.+-]+@[\w.-]+/g, "<email>").slice(0, 160) }));
  console.log(`A1 ORIGINAL ${JSON.stringify({ sessions: sessions.length, verifies: verifies.map((v) => v.status), notOk })}`);
  expect(results.every((result) => result.status === 200)).toBe(true);
  expect(results.filter((result) => result.body.created === true)).toHaveLength(1);
  expect(domainRows(email)).toBe("1,1,1");
  expect(sql(`select m.cohort_id = c.id and c.is_default and c.status = 'ACTIVE' from public.user_cohorts m join auth.users u on u.id = m.user_id
    join public.cohorts c on c.id = m.cohort_id where u.email = '${email}'`)).toBe("t");
  expect(sql(`select count(*) from cohort_data.audit_logs a join auth.users u on a.entity_id = u.id::text where u.email = '${email}' and a.action = 'auth.identity.materialized'`)).toBe("1");
});

const asWorker = "set request.jwt.claim.role = 'service_role';";
const technical = (id: string, email: string) => `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, recovery_sent_at)
  values ('00000000-0000-0000-0000-000000000000', '${id}', 'authenticated', 'authenticated', '${email}', '', null, '{}', '{}', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days');
  update private.signup_attempts set created_at = now() - interval '2 days' where user_id = '${id}';`;

it("the purge skips an identity whose confirmation is in flight and never removes it once confirmed", async () => {
  const [inFlight, idle] = [randomUUID(), randomUUID()];
  sql(technical(inFlight, `a1.confirmando.${inFlight.slice(0, 8)}@institutojef.org.br`) + technical(idle, `a1.parada.${idle.slice(0, 8)}@institutojef.org.br`));
  try {
    // An Auth confirmation of this identity holds its row (hosted Auth confirms the e-mail in that same update).
    const confirmation = sqlInBackground(`begin; select id from auth.users where id = '${inFlight}' for update; select pg_sleep(6.1);
      update auth.users set email_confirmed_at = now(), last_sign_in_at = now() where id = '${inFlight}'; commit;`);
    let confirmed = false;
    void confirmation.then(() => { confirmed = true; });
    await sleeping("pg_sleep(6.1)");
    const purge = await rpc("worker_purge_unconfirmed_identities", { p_limit: 200, p_quiet: "1 hour" }, local().serviceKey);
    expect(purge.status).toBe(200);
    // It answered while the confirmation still held the row: skipped, never waited, never removed.
    expect(confirmed).toBe(false);
    expect(sql(`select count(*) from auth.users where id = '${inFlight}'`)).toBe("1");
    expect(sql(`select count(*) from auth.users where id = '${idle}'`)).toBe("0");
    expect((await confirmation).code).toBe(0);
    expect((await rpc("worker_purge_unconfirmed_identities", { p_limit: 200, p_quiet: "1 hour" }, local().serviceKey)).status).toBe(200);
    expect(sql(`select count(*) from auth.users where id = '${inFlight}' and email_confirmed_at is not null`)).toBe("1");
  } finally {
    sql(`delete from auth.users where id in ('${inFlight}', '${idle}');`);
  }
});

it("a materialization that loses the race to the purge creates nothing", async () => {
  const stale = randomUUID();
  sql(technical(stale, `a1.corrida.limpeza.${stale.slice(0, 8)}@institutojef.org.br`));
  try {
    const purge = sqlInBackground(`begin; ${asWorker} select public.worker_purge_unconfirmed_identities(200, interval '1 hour'); select pg_sleep(3.1); commit;`);
    await sleeping("pg_sleep(3.1)");
    const materialization = await sqlInBackground(`select private.materialize_identity('${stale}', gen_random_uuid());`);
    expect((await purge).code).toBe(0);
    expect(materialization.code).not.toBe(0);
    expect(materialization.stderr).toContain("IDENTITY_NOT_FOUND");
    expect(sql(`select count(*) from auth.users where id = '${stale}'`)).toBe("0");
    expect(sql(`select count(*) from public.profiles where id = '${stale}'`)).toBe("0");
  } finally {
    sql(`delete from auth.users where id = '${stale}';`);
  }
});

it("after the code is spent, a lost materialization is finished by profile completion with the same session", async () => {
  const email = `a1.retomada.${randomUUID().slice(0, 8)}@institutojef.org.br`;
  const sent = new Date().toISOString();
  expect((await auth("otp", { email, create_user: true })).status).toBe(200);
  const verified = await auth("verify", { type: "email", email, token: await latestCode(email, sent) });
  expect(verified.ok).toBe(true);
  const { access_token: token } = await verified.json() as { access_token: string };
  // The verify-time materialization never ran (a transient failure): the code is spent and nobody exists yet.
  expect(domainRows(email)).toBe("0,0,0");
  expect((await auth("verify", { type: "email", email, token: await latestCode(email, sent) })).ok).toBe(false);
  const username = `retomada.${randomUUID().slice(0, 6)}`;
  const completed = await rpc("complete_my_profile", { p_display_name: "Pessoa Retomada", p_username: username, p_avatar_path: null, p_correlation_id: randomUUID() }, token);
  expect(completed.status).toBe(200);
  expect(completed.body).toMatchObject({ username, onboarding_completed: true });
  expect(domainRows(email)).toBe("1,1,1");
  expect((await rpc("materialize_my_signup_identity", { p_correlation_id: randomUUID() }, token)).body.created).toBe(false);
  expect(domainRows(email)).toBe("1,1,1");
});

it("concurrent provisionings of one administrative account create one domain user, in the target cohort only", async () => {
  const { url, serviceKey } = local();
  const cohort = randomUUID();
  // Years are unique (2000-2100): take a free one.
  const year = Number(sql("select year from generate_series(2000, 2100) year where not exists (select 1 from public.cohorts where cohorts.year = year.year) order by random() limit 1"));
  sql(`insert into public.cohorts (id, name, year, slug, status) values ('${cohort}', 'Turma Concorrência A1 ${year}', ${year}, 'a1-${cohort.slice(0, 8)}', 'ACTIVE');
    select private.provision_cohort('${cohort}', null);`);
  const provisioning = randomUUID();
  const email = `a1.provisionada.${randomUUID().slice(0, 8)}@institutojef.org.br`;
  const username = `prov.${randomUUID().slice(0, 8)}`;
  // What the Portal's administrative creation does: Auth inserts the identity, then writes the stamp.
  const created = await fetch(`${url}/auth/v1/admin/users`, { method: "POST", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: `Prov-${randomUUID()}`, email_confirm: true, user_metadata: { name: "Pessoa Provisionada", username }, app_metadata: { germinatura_provisioning: provisioning } }) });
  expect(created.status).toBe(200);
  const { id } = await created.json() as { id: string };
  expect(domainRows(email)).toBe("0,0,0");
  const results = await Promise.all([1, 2, 3].map(() => rpc("complete_admin_provisioned_profile", {
    p_actor_id: "10000000-0000-4000-8000-000000000005", p_user_id: id, p_display_name: "Pessoa Provisionada", p_username: username,
    p_cohort_id: cohort, p_correlation_id: provisioning }, serviceKey)));
  expect(results.some((result) => result.status === 200)).toBe(true);
  expect(domainRows(email)).toBe("1,1,1");
  expect(sql(`select string_agg(cohort_id::text, ',') from public.user_cohorts where user_id = '${id}'`)).toBe(cohort);
  expect(sql(`select string_agg(cohort_id::text, ',') from cohort_data.user_roles where user_id = '${id}'`)).toBe(cohort);
  expect(sql(`select count(*) from cohort_data.audit_logs where entity_id = '${id}' and cohort_id is distinct from '${cohort}'`)).toBe("0");
});
