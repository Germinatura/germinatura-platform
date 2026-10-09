import { COHORT_HEADER, cohortSelectionSchema, type CohortSelection } from "@germinatura/contracts";

/**
 * Cohort context of a Portal request (ADR 0011). One mechanism for every page and route:
 *
 * 1. The selection travels as the `x-germinatura-cohort` header (the PDV and bearer clients) or, in the browser, as
 *    the `germinatura_cohort` cookie set by POST /api/v1/session/cohort. The header wins.
 * 2. The proxy resolves the session with that selection (`get_my_session` validates it in the database against the
 *    active membership or ADMIN_MASTER) and refuses anything the database did not accept.
 * 3. The proxy forwards only the validated selection to the route, in the same header; the Supabase clients of the
 *    route attach it to every database call, where `private.cohort_scope()` validates it again.
 *
 * Without a selection the database falls back to the default cohort (Turma 2026). That fallback exists only for the
 * rollout and is removed in PR 5 (`private.cohort_fallback_enabled()`).
 */
export const COHORT_COOKIE = "germinatura_cohort";
export { COHORT_HEADER };

export type RequestedCohort =
  | { kind: "none" }
  | { kind: "selected"; value: CohortSelection; source: "header" | "cookie" }
  | { kind: "invalid"; source: "header" | "cookie" };

interface CohortCarrier {
  headers: { get(name: string): string | null };
  cookies?: { get(name: string): { value: string } | undefined };
}

export function parseCohortSelection(value: string | null | undefined): CohortSelection | null {
  if (value === null || value === undefined) return null;
  const parsed = cohortSelectionSchema.safeParse(value.trim().toLowerCase());
  return parsed.success ? parsed.data : null;
}

export function requestedCohort(request: CohortCarrier): RequestedCohort {
  const header = request.headers.get(COHORT_HEADER);
  if (header !== null) {
    const value = parseCohortSelection(header);
    return value ? { kind: "selected", value, source: "header" } : { kind: "invalid", source: "header" };
  }
  const cookie = request.cookies?.get(COHORT_COOKIE)?.value;
  if (cookie !== undefined) {
    const value = parseCohortSelection(cookie);
    return value ? { kind: "selected", value, source: "cookie" } : { kind: "invalid", source: "cookie" };
  }
  return { kind: "none" };
}

/** Supabase global headers carrying the selection to the database (none: the database fallback applies). */
export function cohortHeaders(selection: CohortSelection | null | undefined): Record<string, string> {
  return selection ? { [COHORT_HEADER]: selection } : {};
}

/** Did the database accept the requested selection? (The session reports what it resolved.) */
export function selectionAccepted(
  selection: CohortSelection,
  resolved: { cohortMode: "COHORT" | "ALL" | "NONE"; cohort: { id: string } | null },
): boolean {
  if (selection === "all") return resolved.cohortMode === "ALL";
  return resolved.cohortMode === "COHORT" && resolved.cohort?.id === selection;
}

export const cohortCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 24 * 30,
};
