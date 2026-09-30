import { accountSessionsResponseSchema, endAccountSessionsResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { databaseSessionsSchema, endSessionsError, sessionError } from "@/lib/account-sessions";
import { AuthorizationError, requireSession } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

/** Spec 4.8: the signed-in sessions of the caller. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requireSession();
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_my_sessions");
    const rows = databaseSessionsSchema.safeParse(data);
    if (error || !rows.success) return sessionError("SESSIONS_UNAVAILABLE", "Sessões temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(accountSessionsResponseSchema.parse({ data: rows.data.map((row) => ({
      id: row.id, createdAt: row.created_at, lastActiveAt: row.last_active_at, userAgent: row.user_agent, current: row.current,
    })), request_id: requestId }), { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return sessionError(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return sessionError("SESSIONS_UNAVAILABLE", "Sessões temporariamente indisponíveis.", requestId, 503);
  }
}

/** Spec 4.8: ends every session of the caller except the current one. */
export async function DELETE(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requireSession();
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("end_my_sessions", { p_session_id: null, p_correlation_id: crypto.randomUUID() });
    if (error) return endSessionsError(error.message, requestId);
    return NextResponse.json(endAccountSessionsResponseSchema.parse({ data: { ended: Number((data as { ended?: unknown }).ended ?? 0) }, request_id: requestId }),
      { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return sessionError(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return sessionError("SESSIONS_UNAVAILABLE", "Sessões temporariamente indisponíveis.", requestId, 503);
  }
}
