import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Proxy → route of one request, against a fake Supabase project with real ES256 signatures, counting every
// session lookup. The route reads the request headers the proxy forwarded (what Next/Vinext hand to the route).
const routeRequest: { headers: Headers; cookies: Array<{ name: string; value: string }> } = { headers: new Headers(), cookies: [] };
vi.mock("next/headers", () => ({
  headers: async () => routeRequest.headers,
  cookies: async () => ({ getAll: () => routeRequest.cookies, set: () => undefined }),
}));

const { default: proxy } = await import("../proxy");
const { requirePermission, requireSession } = await import("./auth");
const { SESSION_CONTEXT_HEADER, createSessionContext } = await import("./session-context");

const projectUrl = "https://session-flow.supabase.test";
const portalUrl = "https://portal.test";
const kid = "5e55c000-0000-4000-8000-000000000001";
const consumerId = "10000000-0000-4000-8000-000000000003";
const adminId = "10000000-0000-4000-8000-000000000001";

let projectKey: CryptoKeyPair;
let publicJwk: JsonWebKey;
let calls: { authUser: number; sessionLookups: number; denials: number };
let rows: Record<string, Record<string, unknown> | null>;
// ADR 0011: what get_my_session answers for a subject inside the requested cohort (header), when set.
let inCohort: ((subject: string, cohort: string | null) => Record<string, unknown> | null) | null;

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
async function token(sub: string, sessionId = "5e55c000-0000-4000-8000-0000000000aa") {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "ES256", typ: "JWT", kid });
  const body = encode({ sub, session_id: sessionId, role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600 });
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, projectKey.privateKey, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${Buffer.from(signature).toString("base64url")}`;
}
const row = (id: string, roles: string[], overrides: Record<string, unknown> = {}) => ({ auth_id: id, email: `${id.slice(-4)}@institutojef.org.br`,
  display_name: "Pessoa", username: `pessoa${id.slice(-4)}`, avatar_path: null, active: true, onboarding_completed: true, roles, ...overrides });
const subjectOf = (authorization: string | null) => authorization
  ? JSON.parse(Buffer.from(authorization.replace("Bearer ", "").split(".")[1], "base64url").toString()).sub as string : "";

// What the route receives: Next/Vinext rebuild the request headers from the proxy's override list.
function forwardedHeaders(response: Response) {
  const names = response.headers.get("x-middleware-override-headers");
  if (!names) return null;
  const headers = new Headers();
  for (const name of names.split(",")) {
    const value = response.headers.get(`x-middleware-request-${name}`);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

async function viaProxy(path: string, headers: Record<string, string>, method = "GET") {
  const response = await proxy(new NextRequest(new URL(path, portalUrl), { headers, method }));
  const forwarded = forwardedHeaders(response);
  if (forwarded) routeRequest.headers = forwarded;
  return { response, forwarded };
}

beforeAll(async () => {
  projectKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  publicJwk = { ...await crypto.subtle.exportKey("jwk", projectKey.publicKey), kid, alg: "ES256", use: "sig", key_ops: ["verify"] } as JsonWebKey;
});

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", projectUrl);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_unit");
  vi.stubEnv("NEXT_PUBLIC_PORTAL_URL", portalUrl);
  routeRequest.headers = new Headers();
  routeRequest.cookies = [];
  calls = { authUser: 0, sessionLookups: 0, denials: 0 };
  inCohort = null;
  rows = { [consumerId]: row(consumerId, ["CONSUMIDOR"]), [adminId]: row(adminId, ["ADMIN", "CONSUMIDOR"]) };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/auth/v1/.well-known/jwks.json") return Response.json({ keys: [publicJwk] });
    if (path === "/auth/v1/user") {
      calls.authUser += 1;
      return Response.json({ code: 403, error_code: "bad_jwt", msg: "invalid JWT" }, { status: 403 });
    }
    if (path === "/rest/v1/rpc/get_my_session") {
      calls.sessionLookups += 1;
      const subject = subjectOf(request.headers.get("authorization"));
      const answer = inCohort ? inCohort(subject, request.headers.get("x-germinatura-cohort")) : rows[subject] ?? null;
      return new Response(JSON.stringify(answer), { headers: { "Content-Type": "application/json" } });
    }
    if (path === "/rest/v1/rpc/record_authorization_denied") {
      calls.denials += 1;
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("one session lookup per request", () => {
  it("an authenticated API request runs get_my_session exactly once and never calls Auth", async () => {
    const authorization = `Bearer ${await token(consumerId)}`;
    const { response, forwarded } = await viaProxy("/api/v1/notifications", { authorization });
    expect(response.headers.get("location")).toBeNull();
    expect(forwarded?.get(SESSION_CONTEXT_HEADER)).toBeTruthy();
    const user = await requireSession();
    expect(user).toMatchObject({ id: consumerId, roles: ["CONSUMIDOR"] });
    expect(calls).toMatchObject({ authUser: 0, sessionLookups: 1 });
  });

  it("a permission check in the route reuses the same lookup", async () => {
    const authorization = `Bearer ${await token(adminId)}`;
    await viaProxy("/api/v1/admin/users", { authorization });
    expect((await requirePermission("users.manage")).roles).toContain("ADMIN");
    expect(calls.sessionLookups).toBe(1);
  });

  it("a cookie session also costs one lookup", async () => {
    const accessToken = await token(consumerId);
    const session = { access_token: accessToken, refresh_token: "refresh", token_type: "bearer", expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: consumerId, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "" } };
    const cookie = { name: "sb-session-flow-auth-token", value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}` };
    routeRequest.cookies = [cookie];
    await viaProxy("/api/v1/notifications", { cookie: `${cookie.name}=${cookie.value}` });
    expect((await requireSession()).id).toBe(consumerId);
    expect(calls).toMatchObject({ authUser: 0, sessionLookups: 1 });
  });

  it("each request looks the session up again, so a role change applies to the next one", async () => {
    const authorization = `Bearer ${await token(consumerId)}`;
    await viaProxy("/api/v1/notifications", { authorization });
    expect((await requireSession()).roles).toEqual(["CONSUMIDOR"]);
    rows[consumerId] = row(consumerId, ["CONSUMIDOR", "VENDEDOR"]);
    await viaProxy("/api/v1/notifications", { authorization });
    expect((await requireSession()).roles).toEqual(["CONSUMIDOR", "VENDEDOR"]);
    expect(calls.sessionLookups).toBe(2);
  });

  it("an ended session or an inactive person is refused by the proxy", async () => {
    rows[consumerId] = null;
    expect((await viaProxy("/api/v1/notifications", { authorization: `Bearer ${await token(consumerId)}` })).response.status).toBe(401);
    rows[consumerId] = row(consumerId, ["CONSUMIDOR"], { active: false });
    expect((await viaProxy("/api/v1/notifications", { authorization: `Bearer ${await token(consumerId)}` })).response.status).toBe(401);
    rows[consumerId] = row(consumerId, ["CONSUMIDOR"], { onboarding_completed: false });
    expect((await viaProxy("/api/v1/notifications", { authorization: `Bearer ${await token(consumerId)}` })).response.status).toBe(401);
  });

  it("the proxy still refuses a role that does not fit the route", async () => {
    const { response } = await viaProxy("/api/v1/admin/users", { authorization: `Bearer ${await token(consumerId)}` });
    expect(response.status).toBe(403);
    expect(calls).toMatchObject({ sessionLookups: 1, denials: 1 });
  });
});

describe("the session context cannot be forged", () => {
  it("the proxy drops the context header the client sent and forwards its own", async () => {
    const authorization = `Bearer ${await token(consumerId)}`;
    const { forwarded } = await viaProxy("/api/v1/notifications", { authorization, [SESSION_CONTEXT_HEADER]: "client.value" });
    expect(forwarded?.get(SESSION_CONTEXT_HEADER)).not.toBe("client.value");
    expect((await requireSession()).roles).toEqual(["CONSUMIDOR"]);
  });

  it("an anonymous request with a context header gets nothing", async () => {
    const adminContext = await createSessionContext({ user: { id: adminId, authId: adminId, email: "a@institutojef.org.br", perfil: "ADMIN",
      nome: "Admin", username: "admin", avatarPath: null, roles: ["ADMIN"], active: true, onboardingCompleted: true, needsPasswordReset: false, adminMaster: false, cohortMode: "COHORT", cohort: null, cohorts: [] } }, await token(adminId));
    const { response, forwarded } = await viaProxy("/api/v1/admin/users", { [SESSION_CONTEXT_HEADER]: adminContext });
    expect(response.status).toBe(401);
    expect(forwarded?.get(SESSION_CONTEXT_HEADER) ?? null).toBeNull();
  });

  it("a route reached without the proxy never trusts a context for another token, a forged one or an expired one", async () => {
    const consumerToken = await token(consumerId);
    const adminSession = { user: { id: adminId, authId: adminId, email: "a@institutojef.org.br", perfil: "ADMIN" as const, nome: "Admin",
      username: "admin", avatarPath: null, roles: ["ADMIN" as const], active: true as const, onboardingCompleted: true, needsPasswordReset: false as const, adminMaster: false, cohortMode: "COHORT" as const, cohort: null, cohorts: [] } };
    const consumerAsAdmin = { user: { ...adminSession.user, id: consumerId, authId: consumerId } };
    const contexts = [
      await createSessionContext(adminSession, await token(adminId)), // a real context, for another person's token
      await createSessionContext(consumerAsAdmin, await token(consumerId, "5e55c000-0000-4000-8000-0000000000bb")), // same person, other token
      await createSessionContext(consumerAsAdmin, consumerToken, Date.now() - 31_000), // expired
      `${encode({ v: 1, t: "x", e: Date.now() + 10_000, s: consumerAsAdmin })}.${encode("forged")}`, // not signed by this isolate
      "garbage",
    ];
    for (const context of contexts) {
      routeRequest.headers = new Headers({ authorization: `Bearer ${consumerToken}`, [SESSION_CONTEXT_HEADER]: context });
      const user = await requireSession();
      expect(user.roles).toEqual(["CONSUMIDOR"]);
      await expect(requirePermission("users.manage")).rejects.toMatchObject({ status: 403 });
    }
    // Every forged attempt fell back to the database.
    expect(calls.sessionLookups).toBe(contexts.length * 2);
  });
});

describe("cohort context (ADR 0011)", () => {
  const cohortA = "c0000000-0000-4000-8000-000000002026";
  const cohortB = "c0000000-0000-4000-8000-00000000b027";
  const masterId = "10000000-0000-4000-8000-0000000000ff";
  const summary = (id: string) => ({ id, name: id === cohortA ? "Turma 2026" : "Turma 2027", year: id === cohortA ? 2026 : 2027,
    slug: id === cohortA ? "turma-2026" : "turma-2027", status: "ACTIVE", is_default: id === cohortA });
  // The database: the admin belongs to A only; ADMIN_MASTER reads every cohort and "all"; nobody else gets "all".
  function database(subject: string, cohort: string | null) {
    const master = subject === masterId;
    const member = master || cohort === null || cohort === cohortA;
    const all = cohort === "all" && master;
    const base = row(subject, subject === adminId ? ["ADMIN", "CONSUMIDOR"] : [], { admin_master: master,
      cohorts: master ? [summary(cohortA), summary(cohortB)] : [summary(cohortA)] });
    if (all) return { ...base, roles: [], cohort_mode: "ALL", cohort: null };
    // PR 5: ADMIN_MASTER always names the cohort; nobody falls back to a default one.
    if (!member || cohort === "all" || (master && cohort === null)) return { ...base, roles: [], cohort_mode: "NONE", cohort: null };
    const resolved = cohort ?? cohortA;
    return { ...base, cohort_mode: "COHORT", cohort: summary(resolved) };
  }
  const origin = { origin: portalUrl };

  beforeEach(() => { inCohort = database; });

  it("resolves the session inside the selected cohort and forwards only that selection", async () => {
    const { response, forwarded } = await viaProxy("/api/v1/admin/users", { authorization: `Bearer ${await token(adminId)}`, "x-germinatura-cohort": cohortA });
    expect(response.status).toBe(200);
    expect(forwarded?.get("x-germinatura-cohort")).toBe(cohortA);
    expect(await requireSession()).toMatchObject({ cohortMode: "COHORT", cohort: { id: cohortA }, roles: ["ADMIN", "CONSUMIDOR"] });
  });

  it("refuses a cohort without membership, and \"all\" from someone who is not ADMIN_MASTER", async () => {
    for (const cohort of [cohortB, "all"]) {
      const { response } = await viaProxy("/api/v1/admin/users", { authorization: `Bearer ${await token(adminId)}`, "x-germinatura-cohort": cohort });
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe("COHORT_FORBIDDEN");
    }
  });

  it("refuses a malformed context before looking the session up", async () => {
    for (const cohort of ["2026", "all;", `${cohortA},${cohortB}`]) {
      const { response } = await viaProxy("/api/v1/admin/users", { authorization: `Bearer ${await token(adminId)}`, "x-germinatura-cohort": cohort });
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("INVALID_COHORT_CONTEXT");
    }
    expect(calls.sessionLookups).toBe(0);
  });

  it("the header wins over the cookie, and a tampered cookie is refused and cleared", async () => {
    const authorization = `Bearer ${await token(adminId)}`;
    const viaHeader = await viaProxy("/api/v1/admin/users", { authorization, "x-germinatura-cohort": cohortA, cookie: `germinatura_cohort=${cohortB}` });
    expect(viaHeader.response.status).toBe(200);
    const viaCookie = await viaProxy("/api/v1/admin/users", { authorization, cookie: `germinatura_cohort=${cohortB}` });
    expect(viaCookie.response.status).toBe(403);
    expect(viaCookie.response.headers.get("set-cookie")).toMatch(/germinatura_cohort=;/);
  });

  it("ADMIN_MASTER reads in \"all\" but writes cohort data only inside a concrete cohort", async () => {
    const authorization = `Bearer ${await token(masterId)}`;
    const read = await viaProxy("/api/v1/admin/users", { authorization, "x-germinatura-cohort": "all" });
    expect(read.response.status).toBe(200);
    const user = await requireSession();
    expect(user).toMatchObject({ adminMaster: true, cohortMode: "ALL", cohort: null });
    expect(user.roles).toContain("ADMIN_MASTER");
    for (const path of ["/api/v1/admin/catalog/categories", "/api/v1/admin/users", "/api/v1/pdv/handoff"]) {
      const write = await viaProxy(path, { authorization, "x-germinatura-cohort": "all", ...origin }, "POST");
      expect(write.response.status, path).toBe(409);
      expect((await write.response.json()).code).toBe("COHORT_REQUIRED");
    }
    const inCohortWrite = await viaProxy("/api/v1/admin/catalog/categories", { authorization, "x-germinatura-cohort": cohortB, ...origin }, "POST");
    expect(inCohortWrite.response.status).toBe(200);
    expect(inCohortWrite.forwarded?.get("x-germinatura-cohort")).toBe(cohortB);
  });

  it("global operations (cohorts, ADMIN_MASTER, own profile) stay available in \"all\"", async () => {
    const authorization = `Bearer ${await token(masterId)}`;
    for (const [path, method] of [["/api/v1/admin/cohorts", "POST"], [`/api/v1/admin/cohorts/${cohortB}`, "PATCH"],
      [`/api/v1/admin/users/${adminId}/admin-master`, "PUT"], ["/api/v1/profile", "PATCH"], ["/api/v1/session/cohort", "POST"]]) {
      const { response, forwarded } = await viaProxy(path, { authorization, "x-germinatura-cohort": "all", ...origin }, method);
      expect(response.status, path).toBe(200);
      expect(forwarded?.get("x-germinatura-cohort"), path).toBe("all");
    }
  });

  it("in \"all\" only declared consolidated reads pass; any other read asks for a cohort (PR 4)", async () => {
    const authorization = `Bearer ${await token(masterId)}`;
    for (const path of ["/api/v1/admin/finance/payables", "/api/v1/admin/finance/balances", "/api/v1/admin/inventory/lots", "/api/v1/catalog/products"]) {
      const { response } = await viaProxy(path, { authorization, "x-germinatura-cohort": "all" });
      expect(response.status, path).toBe(409);
      expect((await response.json()).code).toBe("COHORT_REQUIRED");
    }
    for (const path of ["/api/v1/admin/finance/sales", "/api/v1/admin/audit", "/api/v1/admin/consolidated/indicators", `/api/v1/admin/users/${adminId}/cohorts`]) {
      const { response, forwarded } = await viaProxy(path, { authorization, "x-germinatura-cohort": "all" });
      expect(response.status, path).toBe(200);
      expect(forwarded?.get("x-germinatura-cohort"), path).toBe("all");
    }
    const quote = await viaProxy("/api/v1/pricing/quote", { authorization, "x-germinatura-cohort": "all", ...origin }, "POST");
    expect(quote.response.status).toBe(409);
  });

  it("in \"all\" a cohort-only screen goes to the explicit cohort selection and comes back", async () => {
    const authorization = `Bearer ${await token(masterId)}`;
    const blocked = await viaProxy("/admin/estoque?q=bolo", { authorization, "x-germinatura-cohort": "all" });
    expect(blocked.response.headers.get("location")).toBe(`${portalUrl}/selecionar-turma?next=%2Fadmin%2Festoque%3Fq%3Dbolo`);
    for (const path of ["/", "/admin/usuarios", "/admin/financeiro/vendas", "/selecionar-turma"]) {
      expect((await viaProxy(path, { authorization, "x-germinatura-cohort": "all" })).response.headers.get("location"), path).toBeNull();
    }
    expect((await viaProxy("/admin/estoque", { authorization, "x-germinatura-cohort": cohortA })).response.headers.get("location")).toBeNull();
  });

  it("without a determinable cohort, screens ask for one instead of falling back to a default (PR 5)", async () => {
    const authorization = `Bearer ${await token(masterId)}`;
    const none = await viaProxy("/admin/usuarios", { authorization });
    expect(none.response.headers.get("location")).toBe(`${portalUrl}/selecionar-turma?next=%2Fadmin%2Fusuarios`);
    for (const path of ["/perfil", "/notificacoes", "/selecionar-turma", "/admin/turmas"]) {
      expect((await viaProxy(path, { authorization })).response.headers.get("location"), path).toBeNull();
    }
  });

  it("?turma= selects a cohort only for a member, resolved against the session, and is dropped otherwise (PR 5)", async () => {
    const member = await viaProxy("/catalogo?turma=turma-2027&q=bolo", { authorization: `Bearer ${await token(masterId)}`, "x-germinatura-cohort": cohortA });
    expect(member.response.headers.get("location")).toBe(`${portalUrl}/catalogo?q=bolo`);
    expect(member.response.headers.get("set-cookie")).toContain(`germinatura_cohort=${cohortB}`);
    const outsider = await viaProxy("/catalogo?turma=turma-2027", { authorization: `Bearer ${await token(adminId)}`, "x-germinatura-cohort": cohortA });
    expect(outsider.response.headers.get("location")).toBe(`${portalUrl}/catalogo`);
    expect(outsider.response.headers.get("set-cookie") ?? "").not.toContain("germinatura_cohort=");
  });

  it("cohort administration is ADMIN_MASTER only, even for an ADMIN of the cohort", async () => {
    const { response } = await viaProxy("/api/v1/admin/cohorts", { authorization: `Bearer ${await token(adminId)}`, "x-germinatura-cohort": cohortA });
    expect(response.status).toBe(403);
  });
});
