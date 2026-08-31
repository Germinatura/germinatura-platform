import { commercialReservationCancelResponseSchema, createApiError, idempotencyKeySchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requireSession } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const paramsSchema = z.object({ id: z.uuid() });
const resultSchema = z.object({
  reservation_id: z.uuid(), status: z.enum(["CANCELLED", "EXPIRED"]), correlation_id: z.uuid(),
  stock_reservation: z.object({
    reservation_id: z.uuid(), status: z.enum(["RELEASED", "EXPIRED"]), release_movement_id: z.uuid().nullable(),
  }),
});
const fail = (code: string, message: string, requestId: string, status: number) => NextResponse.json(
  createApiError(code, message, requestId), { status, headers: { "Cache-Control": "no-store", "x-request-id": requestId } },
);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const params = paramsSchema.safeParse(await context.params);
  if (!key.success || !params.success) return fail("INVALID_RESERVATION_CANCEL", "Cancelamento inválido", requestId, 422);
  try { await requireSession(); } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return fail("RESERVATION_UNAVAILABLE", "Reserva temporariamente indisponível", requestId, 503);
  }
  const correlationId = crypto.randomUUID();
  const supabase = await createAuthenticatedSupabaseClient(request);
  const { data, error } = await supabase.rpc("cancel_commercial_reservation", {
    p_reservation_id: params.data.id, p_idempotency_key: key.data, p_correlation_id: correlationId,
  });
  if (error) {
    if (error.message.includes("NOT_FOUND")) return fail("RESERVATION_NOT_FOUND", "Reserva não encontrada", requestId, 404);
    if (error.message.includes("ALREADY_CONVERTED")) return fail("RESERVATION_ALREADY_CONVERTED", "Reserva já convertida", requestId, 409);
    return fail("RESERVATION_UNAVAILABLE", "Reserva temporariamente indisponível", requestId, 503);
  }
  const result = resultSchema.safeParse(data);
  if (!result.success) return fail("RESERVATION_INVALID_DATA", "Reserva temporariamente indisponível", requestId, 503);
  const value = result.data;
  return NextResponse.json(commercialReservationCancelResponseSchema.parse({ data: {
    reservationId: value.reservation_id, status: value.status,
    stockReservation: { reservationId: value.stock_reservation.reservation_id,
      status: value.stock_reservation.status, releaseMovementId: value.stock_reservation.release_movement_id },
    correlationId: value.correlation_id,
  }, request_id: requestId }), { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
}
