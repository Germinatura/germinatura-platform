import { endAccountSessionsResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { endSessionsError, sessionError } from "@/lib/account-sessions";
import { AuthorizationError, requireSession } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

/** Spec 4.8: ends one of the caller's other sessions. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = createRequestId(request.headers);
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return sessionError("SESSION_NOT_FOUND", "Sessão não encontrada ou já encerrada.", requestId, 404);
  try {
    await requireSession();
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("end_my_sessions", { p_session_id: id.data, p_correlation_id: crypto.randomUUID() });
    if (error) return endSessionsError(error.message, requestId);
    return NextResponse.json(endAccountSessionsResponseSchema.parse({ data: { ended: Number((data as { ended?: unknown }).ended ?? 0) }, request_id: requestId }),
      { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return sessionError(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return sessionError("SESSIONS_UNAVAILABLE", "Sessões temporariamente indisponíveis.", requestId, 503);
  }
}
