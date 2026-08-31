import { createApiError, idempotencyKeySchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requireSession } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
const paramsSchema = z.object({ id: z.uuid() });
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = createRequestId(request.headers); const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const params = paramsSchema.safeParse(await context.params);
  const fail = (code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  if (!key.success || !params.success) return fail("INVALID_RAFFLE_CANCEL", "Cancelamento inválido", 422);
  try { await requireSession(); } catch (error) { if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status); return fail("RAFFLE_UNAVAILABLE", "Rifa temporariamente indisponível", 503); }
  const supabase = await createAuthenticatedSupabaseClient(request); const { data, error } = await supabase.rpc("cancel_raffle_reservation", {
    p_sale_id: params.data.id, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
  });
  if (error) return fail(error.message.includes("NOT_FOUND") ? "RAFFLE_RESERVATION_NOT_FOUND" : "RAFFLE_UNAVAILABLE",
    error.message.includes("NOT_FOUND") ? "Reserva não encontrada" : "Rifa temporariamente indisponível", error.message.includes("NOT_FOUND") ? 404 : 503);
  return NextResponse.json({ data, request_id: requestId }, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
}
