import { cohortModeSchema, cohortSelectionSchema, cohortSummarySchema, sessionRoleSchema } from "@germinatura/contracts";
import { z } from "zod";

/**
 * One session lookup per request (docs/operations/supabase-free-performance.md): the proxy resolves the session,
 * keeps every authorization check it already makes, and hands the result to the route of the same request in this
 * header. The value is signed with an HMAC key that exists only in this isolate's memory, bound to a hash of the
 * access token and valid for a few seconds. The proxy always removes any value the client sent. A missing, forged,
 * expired or foreign value only means the route looks the session up again; it never grants anything.
 */
export const SESSION_CONTEXT_HEADER = "x-germinatura-session-context";
const LIFETIME_MS = 30_000;

const sessionSchema = z.object({
  // The cohort selection the session was resolved for: a route reuses it only for the same selection.
  selection: cohortSelectionSchema.nullable().optional(),
  user: z.object({
    id: z.string().uuid(),
    authId: z.string().uuid(),
    email: z.string().email(),
    perfil: sessionRoleSchema,
    nome: z.string(),
    username: z.string().nullable(),
    avatarPath: z.string().nullable(),
    roles: z.array(sessionRoleSchema).min(1),
    active: z.literal(true),
    onboardingCompleted: z.boolean(),
    needsPasswordReset: z.literal(false),
    adminMaster: z.boolean(),
    cohortMode: cohortModeSchema,
    cohort: cohortSummarySchema.nullable(),
    cohorts: z.array(cohortSummarySchema),
  }).strict(),
}).strict();
const contextSchema = z.object({ v: z.literal(1), t: z.string(), e: z.number(), s: sessionSchema }).strict();
export type ContextSession = z.infer<typeof sessionSchema>;

const encoder = new TextEncoder();
const base64url = (bytes: ArrayBuffer | Uint8Array) => {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromBase64url = (value: string) => {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

// The proxy and the route run in the same isolate but may load this module twice (separate bundles), so the key
// lives on the isolate's global object. It is random, never exported and never leaves memory.
const keySlot = Symbol.for("germinatura.session-context.key");
type KeyHolder = { [keySlot]?: Promise<CryptoKey> };
function isolateKey() {
  const holder = globalThis as KeyHolder;
  holder[keySlot] ??= crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]) as Promise<CryptoKey>;
  return holder[keySlot];
}

async function tokenHash(accessToken: string) {
  return base64url(await crypto.subtle.digest("SHA-256", encoder.encode(accessToken)));
}

export async function createSessionContext(session: ContextSession, accessToken: string, now = Date.now()): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify({ v: 1, t: await tokenHash(accessToken), e: now + LIFETIME_MS, s: session })));
  const signature = await crypto.subtle.sign("HMAC", await isolateKey(), encoder.encode(payload));
  return `${payload}.${base64url(signature)}`;
}

/** The session the proxy resolved for this same token in this same request, or null for anything else. */
export async function readSessionContext(value: string | null | undefined, accessToken: string, now = Date.now()): Promise<ContextSession | null> {
  if (!value || value.length > 8192) return null;
  try {
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra !== undefined) return null;
    const valid = await crypto.subtle.verify("HMAC", await isolateKey(), fromBase64url(signature), encoder.encode(payload));
    if (!valid) return null;
    const parsed = contextSchema.safeParse(JSON.parse(new TextDecoder().decode(fromBase64url(payload))));
    if (!parsed.success || parsed.data.e <= now || parsed.data.e > now + LIFETIME_MS) return null;
    if (parsed.data.t !== await tokenHash(accessToken)) return null;
    return parsed.data.s;
  } catch {
    return null;
  }
}

/** Request headers for the route: the client's value of the context header is always dropped. */
export function forwardSessionContext(headers: Headers, context: string | null): Headers {
  const forwarded = new Headers(headers);
  forwarded.delete(SESSION_CONTEXT_HEADER);
  if (context) forwarded.set(SESSION_CONTEXT_HEADER, context);
  return forwarded;
}
