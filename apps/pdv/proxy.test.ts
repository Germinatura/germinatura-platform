import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import proxy from "./proxy";

// A fake Supabase project with real ES256 signatures; the PDV session lives in the @supabase/ssr cookie.
const projectUrl = "https://pdv-proxy.supabase.test";
const portalUrl = "https://portal.test";
const pdvUrl = "https://pdv.test";
const kid = "5e55b000-0000-4000-8000-000000000001";
const sellerId = "10000000-0000-4000-8000-000000000002";

let projectKey: CryptoKeyPair;
let foreignKey: CryptoKeyPair;
let publicJwk: JsonWebKey;
let calls: { authUser: number; sessionRpc: number };
let sessionRow: Record<string, unknown> | null;
let sessionFor: ((cohort: string | null) => Record<string, unknown> | null) | null;
let sessionHeaders: (string | null)[];

const cohortA = "c0000000-0000-4000-8000-000000002026";
const cohortB = "c0000000-0000-4000-8000-00000000b027";
const summary = (id: string, overrides: Record<string, unknown> = {}) => ({ id, name: id === cohortA ? "Turma 2026" : "Turma 2027",
  year: id === cohortA ? 2026 : 2027, slug: id === cohortA ? "turma-2026" : "turma-2027", status: "ACTIVE", is_default: id === cohortA, ...overrides });

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function token(key = projectKey.privateKey, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "ES256", typ: "JWT", kid });
  const body = encode({ sub: sellerId, session_id: "5e55b000-0000-4000-8000-0000000000aa", role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600, ...overrides });
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${Buffer.from(signature).toString("base64url")}`;
}

async function request(path: string, accessToken?: string, cohortCookie?: string) {
  const headers = new Headers();
  const cookies: string[] = cohortCookie === undefined ? [] : [`germinatura_pdv_cohort=${cohortCookie}`];
  if (accessToken) {
    const session = { access_token: accessToken, refresh_token: "refresh", token_type: "bearer", expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: sellerId, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "" } };
    cookies.push(`sb-pdv-proxy-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`);
  }
  if (cookies.length) headers.set("cookie", cookies.join("; "));
  return proxy(new NextRequest(new URL(path, pdvUrl), { headers }));
}

const seller = (overrides: Record<string, unknown> = {}) => ({ auth_id: sellerId, email: "vendedor.teste@institutojef.org.br", display_name: "Vendedor",
  username: "vendedor.teste", avatar_path: null, active: true, onboarding_completed: true, roles: ["CONSUMIDOR", "VENDEDOR"],
  admin_master: false, cohort_mode: "COHORT", cohort: summary(cohortA), cohorts: [summary(cohortA)], ...overrides });
// What get_my_session answers for a cohort the person cannot read.
const outside = (row: Record<string, unknown>) => ({ ...row, roles: [], cohort_mode: "NONE", cohort: null });

beforeAll(async () => {
  projectKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  foreignKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  publicJwk = { ...await crypto.subtle.exportKey("jwk", projectKey.publicKey), kid, alg: "ES256", use: "sig", key_ops: ["verify"] } as JsonWebKey;
});

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", projectUrl);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_unit");
  vi.stubEnv("NEXT_PUBLIC_PORTAL_URL", portalUrl);
  calls = { authUser: 0, sessionRpc: 0 };
  sessionRow = seller();
  sessionFor = null;
  sessionHeaders = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(new Request(input, init).url).pathname;
    if (path === "/auth/v1/.well-known/jwks.json") return Response.json({ keys: [publicJwk] });
    if (path === "/auth/v1/user") {
      calls.authUser += 1;
      return Response.json({ code: 403, error_code: "bad_jwt", msg: "invalid JWT" }, { status: 403 });
    }
    if (path === "/rest/v1/rpc/get_my_session") {
      calls.sessionRpc += 1;
      const cohort = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("x-germinatura-cohort");
      sessionHeaders.push(cohort);
      const row = sessionFor ? sessionFor(cohort) : sessionRow;
      return new Response(JSON.stringify(row), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("PDV proxy session", () => {
  it("lets an active seller in with one session lookup and no call to Auth", async () => {
    const response = await request("/", await token());
    expect(response.headers.get("location")).toBeNull();
    expect(calls).toEqual({ authUser: 0, sessionRpc: 1 });
  });

  it("sends a visitor without a session to the PDV login", async () => {
    expect((await request("/")).headers.get("location")).toBe(`${pdvUrl}/login`);
    expect(calls.sessionRpc).toBe(0);
  });

  it("refuses a token signed by another key", async () => {
    expect((await request("/", await token(foreignKey.privateKey))).headers.get("location")).toBe(`${pdvUrl}/login`);
    expect(calls.sessionRpc).toBe(0);
  });

  it("treats an ended session as signed out, as getUser did", async () => {
    sessionRow = null;
    expect((await request("/", await token())).headers.get("location")).toBe(`${pdvUrl}/login`);
  });

  it("sends people without the PDV role, inactive or not onboarded back to the Portal", async () => {
    for (const row of [seller({ roles: ["CONSUMIDOR"] }), seller({ active: false }), seller({ onboarding_completed: false })]) {
      sessionRow = row;
      expect((await request("/", await token())).headers.get("location")).toBe(`${portalUrl}/`);
    }
  });

  it("ignores roles carried in the token", async () => {
    sessionRow = seller({ roles: ["CONSUMIDOR"] });
    const forgedRoles = await token(projectKey.privateKey, { app_metadata: { roles: ["VENDEDOR", "ADMIN"] }, user_metadata: { role: "ADMIN" } });
    expect((await request("/", forgedRoles)).headers.get("location")).toBe(`${portalUrl}/`);
  });

  it("infers the only cohort of a single-cohort seller and remembers it for the API calls", async () => {
    const response = await request("/", await token());
    expect(response.headers.get("location")).toBeNull();
    expect(response.cookies.get("germinatura_pdv_cohort")?.value).toBe(cohortA);
    expect(sessionHeaders).toEqual([null]);
  });

  it("validates the selected cohort in the database on every page", async () => {
    const response = await request("/", await token(), cohortA);
    expect(response.headers.get("location")).toBeNull();
    expect(sessionHeaders).toEqual([cohortA]);
  });

  it("sends a seller who forces another cohort back to the selection and forgets it", async () => {
    sessionFor = (cohort) => (cohort === cohortB ? outside(seller()) : seller());
    const response = await request("/", await token(), cohortB);
    expect(response.headers.get("location")).toBe(`${pdvUrl}/turma`);
    expect(response.headers.get("set-cookie")).toMatch(/germinatura_pdv_cohort=;/);
  });

  it("never accepts all, or anything that is not a cohort id, as the PDV context", async () => {
    for (const value of ["all", "ALL", "not-a-cohort"]) {
      sessionHeaders = [];
      const response = await request("/", await token(), value);
      expect(sessionHeaders).toEqual([null]);
      expect(response.headers.get("set-cookie")).toMatch(/germinatura_pdv_cohort=/);
      expect(response.cookies.get("germinatura_pdv_cohort")?.value).toBe(cohortA);
    }
  });

  it("refuses a cohort where the person is only a consumer, or that is archived", async () => {
    for (const row of [seller({ roles: ["CONSUMIDOR"] }), seller({ cohorts: [summary(cohortA, { status: "ARCHIVED" })] })]) {
      sessionRow = row;
      expect((await request("/", await token(), cohortA)).headers.get("location")).toBe(`${pdvUrl}/turma`);
    }
  });

  it("makes a person with more than one open cohort, ADMIN_MASTER included, choose one explicitly", async () => {
    for (const row of [seller({ cohorts: [summary(cohortA), summary(cohortB)] }),
      seller({ roles: [], admin_master: true, cohorts: [summary(cohortA), summary(cohortB)] }),
      seller({ cohort_mode: "NONE", cohort: null, roles: [], admin_master: true })]) {
      sessionRow = row;
      const response = await request("/", await token());
      expect(response.headers.get("location")).toBe(`${pdvUrl}/turma`);
      expect(response.cookies.get("germinatura_pdv_cohort")?.value ?? null).toBeNull();
    }
    // An archived cohort does not count: the only open one is taken.
    sessionRow = seller({ cohorts: [summary(cohortA), summary(cohortB, { status: "ARCHIVED" })] });
    expect((await request("/", await token())).cookies.get("germinatura_pdv_cohort")?.value).toBe(cohortA);
  });

  it("lets ADMIN_MASTER operate inside a selected cohort without a role there", async () => {
    sessionRow = seller({ roles: [], admin_master: true, cohorts: [summary(cohortA), summary(cohortB)], cohort: summary(cohortB) });
    expect((await request("/", await token(), cohortB)).headers.get("location")).toBeNull();
  });

  it("opens the selection page for any active account and keeps the Portal for people without the PDV", async () => {
    sessionRow = seller({ cohorts: [summary(cohortA), summary(cohortB)] });
    expect((await request("/turma", await token())).headers.get("location")).toBeNull();
    sessionRow = seller({ roles: ["CONSUMIDOR"] });
    expect((await request("/", await token())).headers.get("location")).toBe(`${portalUrl}/`);
    expect((await request("/turma")).headers.get("location")).toBe(`${pdvUrl}/login`);
  });

  it("keeps the session-free PWA assets and the handoff page outside Auth", async () => {
    for (const path of ["/offline", "/sw.js", "/manifest.webmanifest", "/acesso"]) {
      expect((await request(path)).headers.get("location")).toBeNull();
    }
    expect(calls.sessionRpc).toBe(0);
  });
});
