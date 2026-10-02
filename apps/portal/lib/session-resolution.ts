import { primaryRole } from "@germinatura/auth";
import { appRoleSchema, type AppRole } from "@germinatura/contracts";
import { structuredLog } from "@germinatura/observability";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const sessionRpcSchema = z.object({
  auth_id: z.string().uuid(),
  email: z.string().email(),
  display_name: z.string().nullable(),
  username: z.string().nullable(),
  avatar_path: z.string().nullable(),
  active: z.boolean(),
  onboarding_completed: z.boolean(),
  roles: z.array(appRoleSchema),
});

export interface SupabaseSession {
  user: {
    id: string;
    authId: string;
    email: string;
    perfil: AppRole;
    nome: string;
    username: string | null;
    avatarPath: string | null;
    roles: AppRole[];
    active: true;
    onboardingCompleted: boolean;
    needsPasswordReset: false;
  };
}

export type SessionResolutionSource = "proxy" | "route" | "login";
type Outcome = "resolved" | "anonymous" | "invalid_token" | "session_unavailable" | "session_rejected";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Staging measurement only (AUTH_TIMING_LOG=1): durations and outcome, never tokens, cookies or who the person is.
function recordTiming(source: SessionResolutionSource, outcome: Outcome, started: number, verified: number) {
  if (process.env.AUTH_TIMING_LOG !== "1") return;
  const finished = Date.now();
  structuredLog("info", "auth.session_resolution", {
    source, outcome, verifyMs: verified - started, sessionMs: finished - verified, totalMs: finished - started,
  });
}

/**
 * Identity: the access token's signature and expiry, checked by `getClaims` against the project's asymmetric signing
 * keys without a call to Auth (with a symmetric secret it asks Auth, as `getUser` did). Everything else comes from
 * `get_my_session` on every call, never from the token or the request: the session still exists (an ended session
 * stops at once, as it did with `getUser`), the person exists and is active, onboarding and roles. Nothing is cached
 * between requests or people.
 */
export async function resolveSupabaseSession(
  client: SupabaseClient,
  accessToken: string | undefined,
  source: SessionResolutionSource,
): Promise<SupabaseSession | null> {
  const started = Date.now();
  let subject: unknown = null;
  let hadToken = Boolean(accessToken);
  try {
    const { data, error } = await client.auth.getClaims(accessToken);
    hadToken ||= Boolean(data || error);
    subject = error ? null : data?.claims.sub;
  } catch {
    // Malformed token or unsupported algorithm.
    hadToken = true;
  }
  const verified = Date.now();
  if (typeof subject !== "string" || !uuidPattern.test(subject)) {
    recordTiming(source, hadToken ? "invalid_token" : "anonymous", started, verified);
    return null;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const rpcClient = accessToken && url && publishableKey
    ? createClient(url, publishableKey, {
        auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      })
    : client;
  const { data, error } = await rpcClient.rpc("get_my_session");
  if (error) {
    recordTiming(source, "session_unavailable", started, verified);
    return null;
  }
  const parsed = sessionRpcSchema.safeParse(data);
  // No row: the session was ended or the person no longer exists. The token and the row must name the same person.
  if (!parsed.success || !parsed.data.active || parsed.data.auth_id !== subject) {
    recordTiming(source, "session_rejected", started, verified);
    return null;
  }
  recordTiming(source, "resolved", started, verified);

  const roles = parsed.data.roles.length > 0 ? parsed.data.roles : ["CONSUMIDOR" as const];
  const perfil = primaryRole(roles);
  return {
    user: {
      id: parsed.data.auth_id,
      authId: parsed.data.auth_id,
      email: parsed.data.email,
      perfil,
      nome: parsed.data.display_name ?? parsed.data.email,
      username: parsed.data.username,
      avatarPath: parsed.data.avatar_path,
      roles,
      active: true,
      onboardingCompleted: parsed.data.onboarding_completed,
      needsPasswordReset: false,
    },
  };
}
