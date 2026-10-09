import { primaryRole } from "@germinatura/auth";
import { appRoleSchema, type CohortMode, type CohortSelection, type CohortSummary, type SessionRole } from "@germinatura/contracts";
import { structuredLog } from "@germinatura/observability";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { cohortHeaders } from "./cohort-context";
import { readSessionContext } from "./session-context";

const sessionRpcSchema = z.object({
  auth_id: z.string().uuid(),
  email: z.string().email(),
  display_name: z.string().nullable(),
  username: z.string().nullable(),
  avatar_path: z.string().nullable(),
  active: z.boolean(),
  onboarding_completed: z.boolean(),
  roles: z.array(appRoleSchema),
  // ADR 0011: the cohort the database resolved for this request, and the cohorts the person may select.
  admin_master: z.boolean().default(false),
  cohort_mode: z.enum(["COHORT", "ALL", "NONE"]).default("NONE"),
  cohort: z.object({ id: z.uuid(), name: z.string(), year: z.number().int(), slug: z.string(),
    status: z.enum(["PREPARING", "ACTIVE", "ARCHIVED"]) }).nullable().default(null),
  cohorts: z.array(z.object({ id: z.uuid(), name: z.string(), year: z.number().int(), slug: z.string(),
    status: z.enum(["PREPARING", "ACTIVE", "ARCHIVED"]), is_default: z.boolean() })).default([]),
});

export interface SupabaseSession {
  /** The cohort selection this session was resolved for (null: none, the database fallback applied). */
  selection?: CohortSelection | null;
  user: {
    id: string;
    authId: string;
    email: string;
    perfil: SessionRole;
    nome: string;
    username: string | null;
    avatarPath: string | null;
    roles: SessionRole[];
    active: true;
    onboardingCompleted: boolean;
    needsPasswordReset: false;
    adminMaster: boolean;
    cohortMode: CohortMode;
    cohort: CohortSummary | null;
    cohorts: CohortSummary[];
  };
}

export type SessionResolutionSource = "proxy" | "route" | "login";
type Outcome = "resolved" | "reused" | "anonymous" | "invalid_token" | "session_unavailable" | "session_rejected";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Staging measurement only (AUTH_TIMING_LOG=1): durations and outcome, never tokens, cookies or who the person is.
function recordTiming(source: SessionResolutionSource, outcome: Outcome, started: number, verified: number) {
  if (process.env.AUTH_TIMING_LOG !== "1") return;
  const finished = Date.now();
  structuredLog("info", "auth.session_resolution", {
    source, outcome, verifyMs: verified - started, sessionMs: finished - verified, totalMs: finished - started,
  });
}

export interface ResolvedSession {
  session: SupabaseSession | null;
  /** The access token that was verified, so the proxy can bind the session context to it. */
  accessToken: string | null;
}

/**
 * Identity: the access token's signature and expiry, checked by `getClaims` against the project's asymmetric signing
 * keys without a call to Auth (with a symmetric secret it asks Auth, as `getUser` did). Everything else comes from
 * `get_my_session`, never from the token or the request: the session still exists (an ended session stops at once,
 * as it did with `getUser`), the person exists and is active, onboarding and roles. The route may reuse the lookup
 * the proxy made for the same verified token in the same request (lib/session-context.ts); nothing is cached
 * between requests or people.
 */
export async function resolveSession(
  client: SupabaseClient,
  accessToken: string | undefined,
  source: SessionResolutionSource,
  sessionContext?: string | null,
  cohort?: CohortSelection | null,
): Promise<ResolvedSession> {
  const started = Date.now();
  let token: string | null = accessToken ?? null;
  let subject: unknown = null;
  let hadToken = Boolean(accessToken);
  try {
    // Cookie sessions: the stored access token, refreshed first when it is about to expire (as getClaims() does).
    if (!token) {
      const { data, error } = await client.auth.getSession();
      hadToken = Boolean(error || data.session);
      token = data.session?.access_token ?? null;
    }
    if (token) {
      const { data, error } = await client.auth.getClaims(token);
      subject = error ? null : data?.claims.sub;
    }
  } catch {
    // Malformed token or unsupported algorithm.
    hadToken = true;
  }
  const verified = Date.now();
  if (!token || typeof subject !== "string" || !uuidPattern.test(subject)) {
    recordTiming(source, hadToken ? "invalid_token" : "anonymous", started, verified);
    return { session: null, accessToken: null };
  }

  const reused = await readSessionContext(sessionContext, token);
  // The proxy's lookup is reused only for the same cohort selection (the session depends on it).
  if (reused && reused.user.id === subject && (reused.selection ?? null) === (cohort ?? null)) {
    recordTiming(source, "reused", started, verified);
    return { session: reused, accessToken: token };
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const rpcClient = accessToken && url && publishableKey
    ? createClient(url, publishableKey, {
        auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${accessToken}`, ...cohortHeaders(cohort) } },
      })
    : client;
  const { data, error } = await rpcClient.rpc("get_my_session");
  if (error) {
    recordTiming(source, "session_unavailable", started, verified);
    return { session: null, accessToken: token };
  }
  const parsed = sessionRpcSchema.safeParse(data);
  // No row: the session was ended or the person no longer exists. The token and the row must name the same person.
  if (!parsed.success || !parsed.data.active || parsed.data.auth_id !== subject) {
    recordTiming(source, "session_rejected", started, verified);
    return { session: null, accessToken: token };
  }
  recordTiming(source, "resolved", started, verified);

  // Roles of the request cohort; ADMIN_MASTER is the global capability, listed next to them (never granted per cohort).
  const cohortRoles: SessionRole[] = parsed.data.roles.length > 0 ? parsed.data.roles : ["CONSUMIDOR"];
  const roles: SessionRole[] = parsed.data.admin_master ? ["ADMIN_MASTER", ...cohortRoles] : cohortRoles;
  const perfil = primaryRole(roles);
  const toSummary = (cohort: { id: string; name: string; year: number; slug: string; status: CohortSummary["status"]; is_default?: boolean }): CohortSummary => ({
    id: cohort.id, name: cohort.name, year: cohort.year, slug: cohort.slug, status: cohort.status,
    ...(cohort.is_default === undefined ? {} : { isDefault: cohort.is_default }),
  });
  const session: SupabaseSession = {
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
      adminMaster: parsed.data.admin_master,
      cohortMode: parsed.data.cohort_mode,
      cohort: parsed.data.cohort ? toSummary(parsed.data.cohort) : null,
      cohorts: parsed.data.cohorts.map(toSummary),
    },
    selection: cohort ?? null,
  };
  return { session, accessToken: token };
}

export async function resolveSupabaseSession(
  client: SupabaseClient,
  accessToken: string | undefined,
  source: SessionResolutionSource,
  sessionContext?: string | null,
  cohort?: CohortSelection | null,
): Promise<SupabaseSession | null> {
  return (await resolveSession(client, accessToken, source, sessionContext, cohort)).session;
}
