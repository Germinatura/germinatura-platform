import { adminReservationsQuerySchema, adminReservationsResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { databaseAdminReservationSchema, reservationDatabaseError, reservationErrorResponse, toAdminReservation } from "@/lib/admin-reservations";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const databaseListSchema = z.object({ items: z.array(databaseAdminReservationSchema), next_cursor: z.uuid().nullable() });

/** Spec 5.10: reservations filtered by status, customer and São Paulo creation period. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("reservations.manage.all");
    const query = adminReservationsQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return reservationErrorResponse("INVALID_RESERVATION_QUERY", "Filtros de reservas inválidos.", requestId, 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_commercial_reservations_admin", {
      p_status: query.data.status ?? null, p_query: query.data.query ?? null, p_from: query.data.from ?? null,
      p_to: query.data.to ?? null, p_cursor: query.data.cursor ?? null, p_limit: 25,
    });
    if (error) return reservationDatabaseError(error.message, requestId);
    const rows = databaseListSchema.safeParse(data);
    if (!rows.success) return reservationErrorResponse("RESERVATIONS_UNAVAILABLE", "Reservas temporariamente indisponíveis.", requestId, 503);
    const response = adminReservationsResponseSchema.safeParse({
      data: rows.data.items.map(toAdminReservation), nextCursor: rows.data.next_cursor, request_id: requestId,
    });
    if (!response.success) return reservationErrorResponse("RESERVATIONS_UNAVAILABLE", "Reservas inválidas.", requestId, 503);
    return NextResponse.json(response.data, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return reservationErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return reservationErrorResponse("RESERVATIONS_UNAVAILABLE", "Reservas temporariamente indisponíveis.", requestId, 503);
  }
}
