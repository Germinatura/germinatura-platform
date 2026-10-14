import { COHORT_HEADER } from "@germinatura/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Cohort context of the PDV (ADR 0011). The PDV always operates inside one concrete cohort, never in "all":
 *
 * - the PDV server chooses the cohort (password login with a single eligible cohort, the Portal handoff, whose cohort
 *   is stored with the single-use code in the database, or the /turma selection) only after `get_my_session`, called
 *   with that cohort, confirms an active account, an active membership and the ADMIN/VENDEDOR role there
 *   (or ADMIN_MASTER);
 * - the choice lives in the `germinatura_pdv_cohort` cookie, which the proxy revalidates on every page;
 * - `apiFetch` sends it as the `x-germinatura-cohort` header to the Portal, whose proxy and database validate it again.
 *
 * The cookie is readable by the page because the header is set in the browser. It carries no authority: a changed
 * value is refused by the PDV proxy and by the Portal exactly like any other cohort without access.
 */
export const PDV_COHORT_COOKIE = "germinatura_pdv_cohort";
export const PDV_COHORT_PAGE = "/turma";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A concrete cohort id, or null. "all" is never a PDV context. */
export function parsePdvCohort(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && uuidPattern.test(normalized) ? normalized : null;
}

export interface PdvCohortOption {
  id: string;
  name: string;
  year: number;
  status: "PREPARING" | "ACTIVE" | "ARCHIVED";
  isDefault: boolean;
}

export interface PdvSession {
  active: boolean;
  onboarded: boolean;
  roles: string[];
  adminMaster: boolean;
  cohortMode: "COHORT" | "ALL" | "NONE";
  cohortId: string | null;
  cohorts: PdvCohortOption[];
}

const statuses = new Set(["PREPARING", "ACTIVE", "ARCHIVED"]);

/** Normalizes a `get_my_session` row; anything unexpected reads as no access. */
export function readPdvSession(data: unknown): PdvSession | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const cohort = record.cohort && typeof record.cohort === "object" ? record.cohort as Record<string, unknown> : null;
  const cohorts = Array.isArray(record.cohorts) ? record.cohorts : [];
  return {
    active: record.active === true,
    onboarded: record.onboarding_completed === true,
    roles: Array.isArray(record.roles) ? record.roles.filter((role): role is string => typeof role === "string") : [],
    adminMaster: record.admin_master === true,
    cohortMode: record.cohort_mode === "COHORT" || record.cohort_mode === "ALL" ? record.cohort_mode : "NONE",
    cohortId: typeof cohort?.id === "string" ? parsePdvCohort(cohort.id) : null,
    cohorts: cohorts.flatMap((item) => {
      const option = item && typeof item === "object" ? item as Record<string, unknown> : null;
      const id = parsePdvCohort(typeof option?.id === "string" ? option.id : null);
      if (!option || !id || typeof option.name !== "string" || typeof option.year !== "number" || !statuses.has(String(option.status))) return [];
      return [{ id, name: option.name, year: option.year, status: option.status as PdvCohortOption["status"], isDefault: option.is_default === true }];
    }),
  };
}

export function accountUsable(session: PdvSession | null): session is PdvSession {
  return session !== null && session.active && session.onboarded;
}

export function hasPdvRole(session: PdvSession): boolean {
  return session.adminMaster || session.roles.includes("ADMIN") || session.roles.includes("VENDEDOR");
}

/** Does this session, resolved with `cohortId`, operate the PDV in exactly that cohort? */
export function operatesPdvIn(session: PdvSession | null, cohortId: string): boolean {
  if (!accountUsable(session) || session.cohortMode !== "COHORT" || session.cohortId !== cohortId) return false;
  const cohort = session.cohorts.find((option) => option.id === cohortId);
  return cohort !== undefined && cohort.status !== "ARCHIVED" && hasPdvRole(session);
}

type SessionClient = Pick<SupabaseClient, "rpc">;

/** `get_my_session` resolved inside one cohort (or with no selection when `cohortId` is null). */
export async function sessionIn(client: SessionClient, cohortId: string | null): Promise<{ session: PdvSession | null; failed: boolean }> {
  const query = client.rpc("get_my_session");
  const { data, error } = await (cohortId ? query.setHeader(COHORT_HEADER, cohortId) : query);
  return { session: error ? null : readPdvSession(data), failed: Boolean(error) };
}

/** The cohorts in which this person may operate the PDV, each confirmed by the database inside that cohort. */
export async function eligiblePdvCohorts(client: SessionClient, base: PdvSession): Promise<PdvCohortOption[]> {
  const candidates = base.cohorts.filter((cohort) => cohort.status !== "ARCHIVED");
  const checks = await Promise.all(candidates.map(async (cohort) => ((await sessionIn(client, cohort.id)).session)));
  return candidates.filter((cohort, index) => operatesPdvIn(checks[index] ?? null, cohort.id));
}

export const pdvCohortCookieOptions = {
  httpOnly: false,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 24 * 30,
};

/** Sets the chosen cohort on a response, or clears a previous one (a new sign-in never inherits it). */
export function withPdvCohort<T extends { cookies: { set(name: string, value: string, options: typeof pdvCohortCookieOptions): unknown; delete(name: string): unknown } }>(
  result: T, cohortId: string | null,
): T {
  if (cohortId) result.cookies.set(PDV_COHORT_COOKIE, cohortId, pdvCohortCookieOptions);
  else result.cookies.delete(PDV_COHORT_COOKIE);
  return result;
}

/** Browser side: the selected cohort for the `x-germinatura-cohort` header. */
export function browserPdvCohort(): string | null {
  if (typeof document === "undefined") return null;
  const entry = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${PDV_COHORT_COOKIE}=`));
  return parsePdvCohort(entry ? decodeURIComponent(entry.slice(PDV_COHORT_COOKIE.length + 1)) : null);
}
