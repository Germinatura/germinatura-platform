import { idempotencyKeySchema, markReservationReadyRequestSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { reservationDatabaseError, reservationErrorResponse } from "@/lib/admin-reservations";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

interface RouteContext { params: Promise<{ id: string }>; }

const databaseResultSchema = z.object({
  reservation_id: z.uuid(), status: z.literal("READY"), ready_at: z.string(), pickup_deadline: z.string(),
  pickup_instructions: z.string().nullable(), correlation_id: z.uuid(),
});

/** Spec 5.10: the commission prepares a reservation and the pickup window starts. */
export async function POST(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = markReservationReadyRequestSchema.safeParse(await request.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !key.success || !parsed.success) {
    return reservationErrorResponse("INVALID_REQUEST", "Confira as instruções de retirada.", requestId, 422);
  }
  try {
    await requirePermission("reservations.manage.all");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("mark_commercial_reservation_ready", {
      p_reservation_id: id, p_pickup_instructions: parsed.data.pickupInstructions,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return reservationDatabaseError(error.message, requestId);
    const result = databaseResultSchema.safeParse(data);
    if (!result.success) return reservationErrorResponse("RESERVATIONS_UNAVAILABLE", "Reservas temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json({
      data: {
        reservationId: result.data.reservation_id, status: result.data.status, readyAt: result.data.ready_at,
        pickupDeadline: result.data.pickup_deadline, pickupInstructions: result.data.pickup_instructions,
        correlationId: result.data.correlation_id,
      },
      request_id: requestId,
    }, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return reservationErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return reservationErrorResponse("RESERVATIONS_UNAVAILABLE", "Reservas temporariamente indisponíveis.", requestId, 503);
  }
}
