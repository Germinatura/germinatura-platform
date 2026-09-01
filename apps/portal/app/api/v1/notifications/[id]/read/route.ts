import { createApiError, notificationReadResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requireSession } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = createRequestId(request.headers);
  const parsedId = z.uuid().safeParse((await context.params).id);
  if (!parsedId.success) return NextResponse.json(createApiError("INVALID_NOTIFICATION", "Notificação inválida", requestId), { status: 422 });
  try { await requireSession(); } catch (error) {
    const status = error instanceof AuthorizationError ? error.status : 503;
    return NextResponse.json(createApiError(status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", "Acesso não autorizado", requestId), { status });
  }
  const client = await createAuthenticatedSupabaseClient(request);
  const { data, error } = await client.rpc("mark_notification_read", { p_notification_id: parsedId.data });
  if (error) {
    const status = error.message.includes("NOTIFICATION_NOT_FOUND") ? 404 : 503;
    return NextResponse.json(createApiError(status === 404 ? "NOTIFICATION_NOT_FOUND" : "NOTIFICATIONS_UNAVAILABLE", status === 404 ? "Notificação não encontrada" : "Notificações temporariamente indisponíveis", requestId), { status });
  }
  const value = z.object({ notification_id: z.uuid(), read_at: z.string() }).parse(data);
  return NextResponse.json(notificationReadResponseSchema.parse({ data: { id: value.notification_id, readAt: value.read_at }, request_id: requestId }), {
    headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}
