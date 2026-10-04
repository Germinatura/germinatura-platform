import {
  createApiError,
  idempotencyKeySchema,
  reopenSellerCloseoutRequestSchema,
  reopenSellerCloseoutResponseSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

interface RouteContext { params: Promise<{ id: string }>; }
const databaseResultSchema = z.object({
  closeout_id: z.uuid(), status: z.literal("REOPENED"), reopened_at: z.string(),
  reopened_by: z.uuid(), reopen_reason: z.string(), correlation_id: z.uuid(),
});

function errorResponse(code: string, message: string, requestId: string, status: number, details?: unknown) {
  return NextResponse.json(createApiError(code, message, requestId, details), {
    status, headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}

export async function POST(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const idempotency = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!idempotency.success) return errorResponse("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key inválida ou ausente", requestId, 422);
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return errorResponse("INVALID_CLOSEOUT", "Fechamento inválido", requestId, 422);
  const parsed = reopenSellerCloseoutRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse("INVALID_REOPEN", "Motivo de reabertura inválido", requestId, 422, parsed.error.issues);
  try {
    await requirePermission("closeouts.manage");
  } catch (error) {
    if (error instanceof AuthorizationError) return errorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return errorResponse("CLOSEOUT_UNAVAILABLE", "Reabertura temporariamente indisponível", requestId, 503);
  }
  let supabase;
  try { supabase = await createAuthenticatedSupabaseClient(request); }
  catch { return errorResponse("CLOSEOUT_UNAVAILABLE", "Reabertura temporariamente indisponível", requestId, 503); }
  const { data, error } = await supabase.rpc("reopen_seller_closeout", {
    p_closeout_id: id, p_reason: parsed.data.reason,
    p_idempotency_key: idempotency.data, p_correlation_id: crypto.randomUUID(),
  });
  if (error) {
    if (error.message.includes("CLOSEOUT_NOT_FOUND")) return errorResponse("CLOSEOUT_NOT_FOUND", "Fechamento não encontrado", requestId, 404);
    if (error.message.includes("CLOSEOUT_NOT_REOPENABLE")) return errorResponse("CLOSEOUT_NOT_REOPENABLE", "Fechamento não pode ser reaberto", requestId, 409);
    if (error.message.includes("IDEMPOTENCY_CONFLICT")) return errorResponse("IDEMPOTENCY_CONFLICT", "A chave já foi usada com outro conteúdo", requestId, 409);
    return errorResponse("CLOSEOUT_UNAVAILABLE", "Reabertura temporariamente indisponível", requestId, 503);
  }
  const result = databaseResultSchema.safeParse(data);
  if (!result.success) return errorResponse("CLOSEOUT_INVALID_DATA", "Reabertura temporariamente indisponível", requestId, 503);
  const value = result.data;
  return NextResponse.json(reopenSellerCloseoutResponseSchema.parse({ data: {
    closeoutId: value.closeout_id, status: value.status, reopenedAt: value.reopened_at,
    reopenedBy: value.reopened_by, reopenReason: value.reopen_reason, correlationId: value.correlation_id,
  }, request_id: requestId }), { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
}
