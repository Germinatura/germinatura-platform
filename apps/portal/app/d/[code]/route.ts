import { shareCodeSchema } from "@germinatura/contracts";
import { NextResponse } from "next/server";
import { createPublicSupabaseClient } from "@/lib/supabase/public";

interface RouteContext { params: Promise<{ code: string }>; }

/** Name of the first-party cookie that carries the campaign origin until a reservation is made. */
const shareOriginCookie = "germinatura_origin";

/**
 * GROW-001: tracked link. Counts the visit, remembers the origin for 7 days and opens the catalog.
 * ADR 0011 (PR 5): the code itself resolves the campaign and its cohort on the server; the catalog opens in that cohort
 * (by its public slug), and a link of a cohort that is not ACTIVE counts nothing.
 */
export async function GET(request: Request, context: RouteContext) {
  const { code } = await context.params;
  const catalog = new URL("/catalogo", request.url);
  const fallback = NextResponse.redirect(catalog);
  fallback.headers.set("Cache-Control", "no-store");
  if (!shareCodeSchema.safeParse(code).success) return fallback;
  const { data } = await createPublicSupabaseClient().rpc("record_share_visit", { p_code: code });
  const visit = data && typeof data === "object" ? data as { cohort_slug?: unknown; cohort_is_default?: unknown } : null;
  if (visit && visit.cohort_is_default === false && typeof visit.cohort_slug === "string") catalog.searchParams.set("turma", visit.cohort_slug);
  const response = NextResponse.redirect(catalog);
  response.headers.set("Cache-Control", "no-store");
  if (data) {
    response.cookies.set(shareOriginCookie, code, {
      httpOnly: true, sameSite: "lax", secure: new URL(request.url).protocol === "https:", maxAge: 7 * 24 * 60 * 60, path: "/",
    });
  }
  return response;
}
