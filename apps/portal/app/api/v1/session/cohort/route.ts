import { cohortSelectionRequestSchema, createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { COHORT_COOKIE, cohortCookieOptions, cohortHeaders, selectionAccepted } from "@/lib/cohort-context";
import { resolveSupabaseSession } from "@/lib/session-resolution";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function headers(requestId: string) {
  return { "Cache-Control": "no-store", "x-request-id": requestId };
}

/**
 * ADR 0011: selects the cohort the Portal works in (a cohort the person belongs to, or "all" for ADMIN_MASTER). The
 * selection is accepted only after the database resolves the session with it; the cookie it sets is validated again
 * by the proxy on every request.
 */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const parsed = cohortSelectionRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(createApiError("INVALID_COHORT_CONTEXT", "Turma inválida.", requestId), { status: 422, headers: headers(requestId) });
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const { data } = await (await createSupabaseServerClient()).auth.getSession();
  const accessToken = data.session?.access_token;
  if (!url || !key || !accessToken) {
    return NextResponse.json(createApiError("UNAUTHENTICATED", "Autenticação obrigatória", requestId), { status: 401, headers: headers(requestId) });
  }
  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}`, ...cohortHeaders(parsed.data.cohort) } },
  });
  const session = await resolveSupabaseSession(client, accessToken, "route", null, parsed.data.cohort);
  if (!session) {
    return NextResponse.json(createApiError("UNAUTHENTICATED", "Autenticação obrigatória", requestId), { status: 401, headers: headers(requestId) });
  }
  if (!selectionAccepted(parsed.data.cohort, session.user)) {
    return NextResponse.json(createApiError("COHORT_FORBIDDEN", "Você não tem acesso a esta turma.", requestId), { status: 403, headers: headers(requestId) });
  }
  const response = NextResponse.json({
    data: { cohortMode: session.user.cohortMode, cohort: session.user.cohort },
    request_id: requestId,
  }, { headers: headers(requestId) });
  response.cookies.set(COHORT_COOKIE, parsed.data.cohort, cohortCookieOptions);
  return response;
}

/** Back to no explicit selection (during the rollout the database falls back to the default cohort). */
export async function DELETE(request: Request) {
  const requestId = createRequestId(request.headers);
  const response = NextResponse.json({ data: { cleared: true }, request_id: requestId }, { headers: headers(requestId) });
  response.cookies.delete(COHORT_COOKIE);
  return response;
}
