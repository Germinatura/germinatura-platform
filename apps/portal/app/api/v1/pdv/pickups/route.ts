import { pickupReservationsResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { reservationDatabaseError, reservationErrorResponse } from "@/lib/admin-reservations";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const databaseRowsSchema = z.array(z.object({
  reservation_id: z.uuid(), customer_name: z.string(), location_id: z.uuid(), location_name: z.string(),
  total_cents: z.number().int(), discount_total_cents: z.number().int(), ready_at: z.string(), pickup_deadline: z.string(),
  pickup_instructions: z.string().nullable(),
  items: z.array(z.object({ product_name: z.string(), quantity: z.number().int(), total_cents: z.number().int() })).nullable(),
}));
const querySchema = z.object({ query: z.string().trim().max(80).optional() }).strict();

/** RES-003: prepared reservations waiting for pickup at the locations the operator runs. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("sales.create");
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return reservationErrorResponse("INVALID_PICKUP_QUERY", "Busca inválida.", requestId, 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_pickup_reservations", { p_query: query.data.query || null, p_limit: 20 });
    if (error) return reservationDatabaseError(error.message, requestId);
    const rows = databaseRowsSchema.safeParse(data);
    if (!rows.success) return reservationErrorResponse("RESERVATIONS_UNAVAILABLE", "Retiradas temporariamente indisponíveis.", requestId, 503);
    const response = pickupReservationsResponseSchema.safeParse({
      data: rows.data.map((row) => ({
        reservationId: row.reservation_id, customerName: row.customer_name, locationId: row.location_id, locationName: row.location_name,
        totalCents: row.total_cents, discountTotalCents: row.discount_total_cents, readyAt: row.ready_at,
        pickupDeadline: row.pickup_deadline, pickupInstructions: row.pickup_instructions,
        items: (row.items ?? []).map((item) => ({ productName: item.product_name, quantity: item.quantity, totalCents: item.total_cents })),
      })),
      request_id: requestId,
    });
    if (!response.success) return reservationErrorResponse("RESERVATIONS_UNAVAILABLE", "Retiradas inválidas.", requestId, 503);
    return NextResponse.json(response.data, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return reservationErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return reservationErrorResponse("RESERVATIONS_UNAVAILABLE", "Retiradas temporariamente indisponíveis.", requestId, 503);
  }
}
