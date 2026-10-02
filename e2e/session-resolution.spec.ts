import { expect, test, type APIRequestContext } from "@playwright/test";
import { execFileSync } from "node:child_process";

// Session resolution without an Auth round trip (docs/operations/stability-report.md): identity from the locally
// verified token, everything else from get_my_session on every request. These journeys pin the guarantees.
const portalUrl = "http://127.0.0.1:3000";
const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";
const adminId = "10000000-0000-4000-8000-000000000001";

function localSupabase() {
  const output = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = output.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = output.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key) throw new Error("Supabase local indisponível para o E2E de sessão");
  return { url, key };
}

// A separate session straight from Supabase Auth, as the PDV browser client holds it.
async function signIn(email: string, password: string) {
  const { url, key } = localSupabase();
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const body = await response.json() as { access_token?: string };
  if (!response.ok || !body.access_token) throw new Error(`Login de fixture recusado: ${response.status}`);
  return body.access_token;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as Record<string, unknown>;

async function portalLogin(request: APIRequestContext, identifier: string, password: string) {
  const response = await request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl, "Sec-Fetch-Site": "same-origin" }, data: { identifier, password } });
  expect(response.status()).toBe(200);
}

test("a valid session resolves by cookie and by bearer token", async ({ request }) => {
  await portalLogin(request, "consumidor.teste", "Consumidor123!");
  await expect((await request.get(`${portalUrl}/api/auth/me`)).json()).resolves.toMatchObject({ user: { username: "consumidor.teste" } });
  const token = await signIn("consumidor.teste@institutojef.org.br", "Consumidor123!");
  const me = await request.get(`${portalUrl}/api/auth/me`, { headers: bearer(token) });
  expect(me.status()).toBe(200);
  await expect(me.json()).resolves.toMatchObject({ user: { roles: ["CONSUMIDOR"] } });
});

test("invalid, altered or foreign tokens are refused", async ({ playwright }) => {
  const anonymous = await playwright.request.newContext();
  const token = await signIn("consumidor.teste@institutojef.org.br", "Consumidor123!");
  const [header, , signature] = token.split(".");
  // Claims rewritten to the administrator, original signature kept.
  const altered = `${header}.${encode({ ...claimsOf(token), sub: adminId, app_metadata: { roles: ["ADMIN"] } })}.${signature}`;
  // Signed with a key of our own under the project's key id.
  const { url } = localSupabase();
  const { keys } = await (await fetch(`${url}/auth/v1/.well-known/jwks.json`)).json() as { keys: Array<{ kid: string }> };
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const foreignHeader = encode({ alg: "ES256", typ: "JWT", kid: keys[0]?.kid });
  const foreignBody = encode({ ...claimsOf(token), sub: adminId });
  const foreignSignature = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(`${foreignHeader}.${foreignBody}`))).toString("base64url");
  const foreign = `${foreignHeader}.${foreignBody}.${foreignSignature}`;
  const unsigned = `${encode({ alg: "none", typ: "JWT" })}.${encode({ ...claimsOf(token), sub: adminId })}.`;
  const expired = `${header}.${encode({ ...claimsOf(token), exp: Math.floor(Date.now() / 1000) - 60 })}.${signature}`;

  for (const forged of [altered, foreign, unsigned, expired, "expired.fixture.token", "abc"]) {
    for (const path of ["/api/auth/me", "/api/v1/notifications?limit=5", "/api/v1/admin/users"]) {
      expect((await anonymous.get(`${portalUrl}${path}`, { headers: bearer(forged) })).status(), `${path} com token forjado`).toBe(401);
    }
  }
  await anonymous.dispose();
});

test("headers sent by the client never grant a role or a session", async ({ playwright }) => {
  const forgedContext = {
    "x-middleware-subrequest": "middleware:middleware:middleware:middleware:middleware",
    "x-user-id": adminId, "x-user-roles": "ADMIN", "x-germinatura-session": JSON.stringify({ roles: ["ADMIN"] }),
    "x-supabase-auth": adminId, "x-forwarded-user": "admin.teste",
  };
  const anonymous = await playwright.request.newContext();
  expect((await anonymous.get(`${portalUrl}/api/v1/admin/users`, { headers: forgedContext })).status()).toBe(401);
  expect((await anonymous.get(`${portalUrl}/api/auth/me`, { headers: forgedContext })).status()).toBe(401);
  await anonymous.dispose();

  const consumer = await playwright.request.newContext();
  await portalLogin(consumer, "consumidor.teste", "Consumidor123!");
  expect((await consumer.get(`${portalUrl}/api/v1/admin/users`, { headers: forgedContext })).status()).toBe(403);
  expect((await consumer.get(`${pdvUrl}/api/v1/pdv/sales`, { headers: forgedContext })).status()).toBe(403);
  await consumer.dispose();
});

test("role changes and deactivation apply on the next request, in the Portal and in the PDV", async ({ playwright }) => {
  const suffix = Date.now().toString(36);
  const email = `sessao.e2e.${suffix}@institutojef.org.br`;
  const password = "SessaoE2e123!";
  const admin = await playwright.request.newContext();
  await portalLogin(admin, "admin.teste", "Admin123!");
  const provisioned = await admin.post(`${portalUrl}/api/v1/admin/users`, { headers: { Origin: portalUrl },
    data: { email, displayName: "Pessoa Sessão E2E", username: `sessao.${suffix}`, password, roles: ["CONSUMIDOR"], active: true } });
  expect(provisioned.status()).toBe(201);
  const userId = (await provisioned.json() as { data: { user_id: string } }).data.user_id;
  const setAccess = async (roles: string[], active: boolean) => expect((await admin.patch(`${portalUrl}/api/v1/admin/users/${userId}/roles`,
    { headers: { Origin: portalUrl }, data: { roles, active } })).status()).toBe(200);

  const person = await playwright.request.newContext();
  const token = await signIn(email, password);
  expect((await person.get(`${pdvUrl}/api/v1/pdv/sales`, { headers: bearer(token) })).status()).toBe(403);

  await setAccess(["CONSUMIDOR", "VENDEDOR"], true);
  expect((await person.get(`${pdvUrl}/api/v1/pdv/sales`, { headers: bearer(token) })).status()).toBe(200);
  expect((await person.get(`${portalUrl}/api/v1/admin/users`, { headers: bearer(token) })).status()).toBe(403);

  await setAccess(["CONSUMIDOR"], true);
  expect((await person.get(`${pdvUrl}/api/v1/pdv/sales`, { headers: bearer(token) })).status()).toBe(403);

  await setAccess(["CONSUMIDOR"], false);
  expect((await person.get(`${portalUrl}/api/auth/me`, { headers: bearer(token) })).status()).toBe(401);
  expect((await person.get(`${portalUrl}/api/v1/notifications?limit=5`, { headers: bearer(token) })).status()).toBe(401);
  await person.dispose();
  await admin.dispose();
});

test("logout ends the session at once, even for a copy of its cookies", async ({ browser }) => {
  const context = await browser.newContext();
  await portalLogin(context.request, "consumidor.teste", "Consumidor123!");
  const copy = await context.storageState();
  expect((await context.request.post(`${portalUrl}/api/auth/logout`, { headers: { Origin: portalUrl } })).status()).toBe(200);
  expect((await context.request.get(`${portalUrl}/api/auth/me`)).status()).toBe(401);
  await context.close();

  const replay = await browser.newContext({ storageState: copy });
  expect((await replay.request.get(`${portalUrl}/api/auth/me`)).status()).toBe(401);
  const page = await replay.newPage();
  await page.goto(`${portalUrl}/inicio`);
  await expect(page).toHaveURL(`${portalUrl}/login`);
  await replay.close();
});

test("ending another session (Sessões ativas) locks it out of the Portal and the PDV at once", async ({ browser }) => {
  // The seller is signed in on the PDV with cookies…
  const pdv = await browser.newContext();
  const login = await pdv.request.post(`${pdvUrl}/api/auth/login`, { headers: { Origin: pdvUrl, "Sec-Fetch-Site": "same-origin" }, data: { identifier: "vendedor.teste", password: "Vendedor123!" } });
  expect(login.status()).toBe(200);
  const pdvPage = await pdv.newPage();
  await pdvPage.goto(`${pdvUrl}/`);
  await expect(pdvPage).toHaveURL(`${pdvUrl}/`);
  const pdvSessions = await (await pdv.request.get(`${pdvUrl}/api/v1/account/sessions`)).json() as { data: Array<{ id: string; current: boolean }> };
  const pdvSessionId = pdvSessions.data.find((session) => session.current)?.id;
  expect(pdvSessionId).toBeTruthy();

  // …and also holds a second session, from which they end the first one.
  const token = await signIn("vendedor.teste@institutojef.org.br", "Vendedor123!");
  const ended = await pdv.request.delete(`${portalUrl}/api/v1/account/sessions/${pdvSessionId}`, { headers: bearer(token) });
  expect(ended.status()).toBe(200);

  expect((await pdv.request.get(`${pdvUrl}/api/v1/pdv/sales`)).status()).toBe(401);
  await pdvPage.goto(`${pdvUrl}/`);
  await expect(pdvPage).toHaveURL(`${pdvUrl}/login`);
  // The session that did the ending keeps working.
  expect((await pdv.request.get(`${pdvUrl}/api/v1/pdv/sales`, { headers: bearer(token) })).status()).toBe(200);
  await pdv.close();
  expect(claimsOf(token).session_id).not.toBe(pdvSessionId);
});
