import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSupabaseSession } from "./session-resolution";

// A fake Supabase project: real ES256 signatures, a JWKS endpoint, Auth and the session RPC, counting every call.
const projectUrl = "https://session-resolution.supabase.test";
const publishableKey = "sb_publishable_unit";
const kid = "5e55a000-0000-4000-8000-000000000001";
const personId = "10000000-0000-4000-8000-000000000003";
const sessionId = "5e55a000-0000-4000-8000-0000000000aa";

type Row = Record<string, unknown> | null;
let projectKey: CryptoKeyPair;
let foreignKey: CryptoKeyPair;
let publicJwk: JsonWebKey;
let calls: { jwks: number; authUser: number; sessionRpc: number; rpcAuthorization: string[] };
let sessionRow: Row | Error;

const encode = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

async function sign(payload: Record<string, unknown>, options: { key?: CryptoKey; alg?: string; kid?: string } = {}) {
  const header = encode({ alg: options.alg ?? "ES256", typ: "JWT", kid: options.kid ?? kid });
  const body = encode(payload);
  if (options.alg && options.alg !== "ES256") return `${header}.${body}.${encode("not-a-signature")}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, options.key ?? projectKey.privateKey, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${Buffer.from(signature).toString("base64url")}`;
}

function claims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { sub: personId, session_id: sessionId, role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600, ...overrides };
}

function row(overrides: Record<string, unknown> = {}) {
  return { auth_id: personId, email: "consumidor.teste@institutojef.org.br", display_name: "Consumidor", username: "consumidor.teste",
    avatar_path: null, active: true, onboarding_completed: true, roles: ["CONSUMIDOR"], ...overrides };
}

async function resolve(token: string) {
  const client = createClient(projectUrl, publishableKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  return resolveSupabaseSession(client, token, "route");
}

beforeAll(async () => {
  projectKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  foreignKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  publicJwk = { ...await crypto.subtle.exportKey("jwk", projectKey.publicKey), kid, alg: "ES256", use: "sig", key_ops: ["verify"] } as JsonWebKey;
});

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", projectUrl);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", publishableKey);
  calls = { jwks: 0, authUser: 0, sessionRpc: 0, rpcAuthorization: [] };
  sessionRow = row();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/auth/v1/.well-known/jwks.json") {
      calls.jwks += 1;
      return Response.json({ keys: [publicJwk] });
    }
    if (path === "/auth/v1/user") {
      calls.authUser += 1;
      return Response.json({ code: 403, error_code: "bad_jwt", msg: "invalid JWT" }, { status: 403 });
    }
    if (path === "/rest/v1/rpc/get_my_session") {
      calls.sessionRpc += 1;
      calls.rpcAuthorization.push(request.headers.get("authorization") ?? "");
      if (sessionRow instanceof Error) return Response.json({ message: sessionRow.message }, { status: 500 });
      return new Response(JSON.stringify(sessionRow), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("session resolution", () => {
  it("resolves a valid session with one session lookup and no call to Auth", async () => {
    const token = await sign(claims());
    const session = await resolve(token);
    expect(session?.user).toMatchObject({ id: personId, roles: ["CONSUMIDOR"], perfil: "CONSUMIDOR", onboardingCompleted: true });
    expect(calls.authUser).toBe(0);
    expect(calls.sessionRpc).toBe(1);
    // The session lookup runs as the person (RLS and auth.uid()), with the same token.
    expect(calls.rpcAuthorization).toEqual([`Bearer ${token}`]);
  });

  it("fetches the signing keys at most once for many resolutions", async () => {
    const token = await sign(claims());
    for (let index = 0; index < 5; index += 1) await resolve(token);
    expect(calls.jwks).toBeLessThanOrEqual(1);
    expect(calls.authUser).toBe(0);
    expect(calls.sessionRpc).toBe(5);
  });

  it("rejects a token signed by another key, without looking up the session", async () => {
    expect(await resolve(await sign(claims(), { key: foreignKey.privateKey }))).toBeNull();
    expect(calls.sessionRpc).toBe(0);
  });

  it("rejects a token whose claims were altered after signing", async () => {
    const [header, , signature] = (await sign(claims())).split(".");
    const forged = `${header}.${encode(claims({ sub: "10000000-0000-4000-8000-000000000001" }))}.${signature}`;
    expect(await resolve(forged)).toBeNull();
    expect(calls.sessionRpc).toBe(0);
  });

  it("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    expect(await resolve(await sign(claims({ iat: past - 3600, exp: past })))).toBeNull();
    expect(calls.sessionRpc).toBe(0);
  });

  it("sends symmetric or unsigned tokens to Auth, which refuses them", async () => {
    expect(await resolve(await sign(claims(), { alg: "HS256" }))).toBeNull();
    expect(await resolve(await sign(claims(), { alg: "none" }))).toBeNull();
    expect(calls.authUser).toBeGreaterThanOrEqual(1);
    expect(calls.sessionRpc).toBe(0);
  });

  it("treats malformed tokens as signed out instead of failing", async () => {
    for (const token of ["abc", "a.b.c", "expired.fixture.token", `${encode({ alg: "ES256", kid })}.${encode("{")}.x`]) {
      await expect(resolve(token)).resolves.toBeNull();
    }
    expect(calls.sessionRpc).toBe(0);
  });

  it("rejects a token without a person", async () => {
    expect(await resolve(await sign(claims({ sub: undefined, role: "anon" })))).toBeNull();
    expect(calls.sessionRpc).toBe(0);
  });

  it("rejects an ended session (logout, Sessões ativas): the lookup returns no row", async () => {
    sessionRow = null;
    expect(await resolve(await sign(claims()))).toBeNull();
  });

  it("rejects an inactive person", async () => {
    sessionRow = row({ active: false });
    expect(await resolve(await sign(claims()))).toBeNull();
  });

  it("keeps incomplete onboarding visible to the callers that block it", async () => {
    sessionRow = row({ onboarding_completed: false, username: null });
    expect((await resolve(await sign(claims())))?.user.onboardingCompleted).toBe(false);
  });

  it("rejects a lookup that names someone other than the token", async () => {
    sessionRow = row({ auth_id: "10000000-0000-4000-8000-000000000001", roles: ["ADMIN"] });
    expect(await resolve(await sign(claims()))).toBeNull();
  });

  it("fails closed when the session lookup fails", async () => {
    sessionRow = new Error("connection reset");
    expect(await resolve(await sign(claims()))).toBeNull();
  });

  it("takes roles only from the database, never from the token", async () => {
    const token = await sign(claims({ app_metadata: { roles: ["ADMIN"] }, user_metadata: { role: "ADMIN" }, user_role: "ADMIN" }));
    expect((await resolve(token))?.user.roles).toEqual(["CONSUMIDOR"]);
  });

  it("reflects a role change on the next request (nothing is cached)", async () => {
    const token = await sign(claims());
    expect((await resolve(token))?.user.roles).toEqual(["CONSUMIDOR"]);
    sessionRow = row({ roles: ["CONSUMIDOR", "VENDEDOR"] });
    expect((await resolve(token))?.user.perfil).toBe("VENDEDOR");
    sessionRow = row({ roles: ["CONSUMIDOR"] });
    expect((await resolve(token))?.user.perfil).toBe("CONSUMIDOR");
    expect(calls.sessionRpc).toBe(3);
  });

  it("logs only durations and outcome when timing is enabled", async () => {
    vi.stubEnv("AUTH_TIMING_LOG", "1");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const token = await sign(claims());
    await resolve(token);
    await resolve("abc");
    const lines = info.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(lines.map((line) => line.outcome)).toEqual(["resolved", "invalid_token"]);
    expect(Object.keys(lines[0]).sort()).toEqual(["event", "level", "outcome", "sessionMs", "source", "timestamp", "totalMs", "verifyMs"]);
    const printed = info.mock.calls.flat().join("\n");
    for (const secret of [token, personId, sessionId, "consumidor"]) expect(printed).not.toContain(secret);
  });

  it("logs nothing by default", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await resolve(await sign(claims()));
    expect(info).not.toHaveBeenCalled();
  });
});
