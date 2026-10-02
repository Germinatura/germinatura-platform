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

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function token(key = projectKey.privateKey, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "ES256", typ: "JWT", kid });
  const body = encode({ sub: sellerId, session_id: "5e55b000-0000-4000-8000-0000000000aa", role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600, ...overrides });
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${Buffer.from(signature).toString("base64url")}`;
}

async function request(path: string, accessToken?: string) {
  const headers = new Headers();
  if (accessToken) {
    const session = { access_token: accessToken, refresh_token: "refresh", token_type: "bearer", expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: sellerId, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "" } };
    headers.set("cookie", `sb-pdv-proxy-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`);
  }
  return proxy(new NextRequest(new URL(path, pdvUrl), { headers }));
}

const seller = (overrides: Record<string, unknown> = {}) => ({ auth_id: sellerId, email: "vendedor.teste@institutojef.org.br", display_name: "Vendedor",
  username: "vendedor.teste", avatar_path: null, active: true, onboarding_completed: true, roles: ["CONSUMIDOR", "VENDEDOR"], ...overrides });

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
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(new Request(input, init).url).pathname;
    if (path === "/auth/v1/.well-known/jwks.json") return Response.json({ keys: [publicJwk] });
    if (path === "/auth/v1/user") {
      calls.authUser += 1;
      return Response.json({ code: 403, error_code: "bad_jwt", msg: "invalid JWT" }, { status: 403 });
    }
    if (path === "/rest/v1/rpc/get_my_session") {
      calls.sessionRpc += 1;
      return new Response(JSON.stringify(sessionRow), { headers: { "Content-Type": "application/json" } });
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

  it("keeps the session-free PWA assets and the handoff page outside Auth", async () => {
    for (const path of ["/offline", "/sw.js", "/manifest.webmanifest", "/acesso"]) {
      expect((await request(path)).headers.get("location")).toBeNull();
    }
    expect(calls.sessionRpc).toBe(0);
  });
});
