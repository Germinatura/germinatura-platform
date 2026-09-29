import { adminReservationSchema, createApiError } from "@germinatura/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

// Rows returned by public.list_commercial_reservations_admin.
export const databaseAdminReservationSchema = z.object({
  reservation_id: z.uuid(), status: z.string(), created_at: z.string(), customer_id: z.uuid(), customer_name: z.string(),
  location_name: z.string(), total_cents: z.number().int(), discount_total_cents: z.number().int(), expires_at: z.string(),
  ready_at: z.string().nullable(), pickup_deadline: z.string().nullable(), pickup_instructions: z.string().nullable(),
  converted_sale_id: z.uuid().nullable(),
  items: z.array(z.object({ product_name: z.string(), quantity: z.number().int(), total_cents: z.number().int() })).nullable(),
});

export function toAdminReservation(value: z.infer<typeof databaseAdminReservationSchema>) {
  return adminReservationSchema.parse({
    reservationId: value.reservation_id, status: value.status, createdAt: value.created_at, customerId: value.customer_id,
    customerName: value.customer_name, locationName: value.location_name, totalCents: value.total_cents,
    discountTotalCents: value.discount_total_cents, expiresAt: value.expires_at, readyAt: value.ready_at,
    pickupDeadline: value.pickup_deadline, pickupInstructions: value.pickup_instructions, convertedSaleId: value.converted_sale_id,
    items: (value.items ?? []).map((item) => ({ productName: item.product_name, quantity: item.quantity, totalCents: item.total_cents })),
  });
}

export function reservationErrorResponse(code: string, message: string, requestId: string, status: number) {
  return NextResponse.json(createApiError(code, message, requestId), {
    status, headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}

/** Maps database errors of the reservation administration commands to API responses. */
export function reservationDatabaseError(message: string, requestId: string) {
  const conflicts: Record<string, string> = {
    COMMERCIAL_RESERVATION_NOT_ACTIVE: "A reserva não está mais ativa.",
    COMMERCIAL_RESERVATION_EXPIRED: "A reserva expirou.",
    IDEMPOTENCY_CONFLICT: "A chave já foi usada com outro conteúdo.",
    IDEMPOTENCY_IN_PROGRESS: "A operação já está em processamento.",
  };
  const code = Object.keys(conflicts).find((key) => message.includes(key));
  if (code) return reservationErrorResponse(code, conflicts[code], requestId, 409);
  if (message.includes("COMMERCIAL_RESERVATION_NOT_FOUND")) return reservationErrorResponse("NOT_FOUND", "Reserva não encontrada.", requestId, 404);
  if (message.includes("RESERVATIONS_MANAGE_REQUIRED")) return reservationErrorResponse("FORBIDDEN", "Operação não autorizada.", requestId, 403);
  if (message.includes("INVALID_")) return reservationErrorResponse("INVALID_REQUEST", "Confira os dados informados.", requestId, 422);
  return reservationErrorResponse("RESERVATIONS_UNAVAILABLE", "Reservas temporariamente indisponíveis.", requestId, 503);
}
