import { commercialReservationConvertResponseSchema, createApiError, idempotencyKeySchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requireSession } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const paramsSchema = z.object({ id: z.uuid() });
const resultSchema = z.discriminatedUnion("status", [
  z.object({ reservation_id: z.uuid(), status: z.literal("CONVERTED"), sale_id: z.uuid(),
    sale_status: z.literal("AWAITING_PAYMENT"), payment_attempt_id: z.uuid(), stock_reservation_id: z.uuid(),
    total_cents: z.number().int().nonnegative(), correlation_id: z.uuid() }),
  z.object({ reservation_id: z.uuid(), status: z.literal("EXPIRED"), sale_id: z.null(),
    payment_attempt_id: z.null(), correlation_id: z.uuid() }),
]);
const fail = (code: string, message: string, requestId: string, status: number) => NextResponse.json(
  createApiError(code, message, requestId), { status, headers: { "Cache-Control": "no-store", "x-request-id": requestId } },
);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const params = paramsSchema.safeParse(await context.params);
  if (!key.success || !params.success) return fail("INVALID_RESERVATION_CONVERSION", "Conversão inválida", requestId, 422);
  try { await requireSession(); } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return fail("RESERVATION_UNAVAILABLE", "Reserva temporariamente indisponível", requestId, 503);
  }
  const correlationId = crypto.randomUUID();
  const supabase = await createAuthenticatedSupabaseClient(request);
  const { data, error } = await supabase.rpc("convert_commercial_reservation", {
    p_reservation_id: params.data.id, p_idempotency_key: key.data, p_correlation_id: correlationId,
  });
  if (error) {
    if (error.message.includes("NOT_FOUND")) return fail("RESERVATION_NOT_FOUND", "Reserva não encontrada", requestId, 404);
    if (error.message.includes("NOT_ACTIVE")) return fail("RESERVATION_NOT_ACTIVE", "Reserva não está ativa", requestId, 409);
    return fail("RESERVATION_UNAVAILABLE", "Reserva temporariamente indisponível", requestId, 503);
  }
  const result = resultSchema.safeParse(data);
  if (!result.success) return fail("RESERVATION_INVALID_DATA", "Reserva temporariamente indisponível", requestId, 503);
  const value = result.data;
  const dataOut = value.status === "EXPIRED" ? {
    reservationId: value.reservation_id, status: value.status, saleId: null,
    paymentAttemptId: null, correlationId: value.correlation_id,
  } : {
    reservationId: value.reservation_id, status: value.status, saleId: value.sale_id,
    saleStatus: value.sale_status, paymentAttemptId: value.payment_attempt_id,
    stockReservationId: value.stock_reservation_id, totalCents: value.total_cents,
    correlationId: value.correlation_id,
  };
  return NextResponse.json(commercialReservationConvertResponseSchema.parse({ data: dataOut, request_id: requestId }),
    { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
}
