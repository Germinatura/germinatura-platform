import { shareCodeSchema } from "@germinatura/contracts";
import { NextResponse } from "next/server";
import { createPublicSupabaseClient } from "@/lib/supabase/public";

interface RouteContext { params: Promise<{ code: string }>; }

/** Name of the first-party cookie that carries the campaign origin until a reservation is made. */
const shareOriginCookie = "germinatura_origin";

/** GROW-001: tracked link. Counts the visit, remembers the origin for 7 days and opens the catalog. */
export async function GET(request: Request, context: RouteContext) {
  const { code } = await context.params;
  const response = NextResponse.redirect(new URL("/catalogo", request.url));
  response.headers.set("Cache-Control", "no-store");
  if (!shareCodeSchema.safeParse(code).success) return response;
  const { data } = await createPublicSupabaseClient().rpc("record_share_visit", { p_code: code });
  if (data) {
    response.cookies.set(shareOriginCookie, code, {
      httpOnly: true, sameSite: "lax", secure: new URL(request.url).protocol === "https:", maxAge: 7 * 24 * 60 * 60, path: "/",
    });
  }
  return response;
}
