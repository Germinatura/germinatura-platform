import { idempotencyKeySchema, reservationSettingsResponseSchema, reservationSettingsSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { reservationDatabaseError, reservationErrorResponse } from "@/lib/admin-reservations";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });
const databaseSettingsSchema = z.object({ hold_hours: z.number().int(), pickup_hours: z.number().int() });

/** Spec 5.17: reservation hold and pickup windows, in hours. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("reservations.manage.all");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.from("reservation_settings").select("hold_hours,pickup_hours").eq("singleton", true).maybeSingle();
    const row = databaseSettingsSchema.safeParse(data);
    if (error || !row.success) return reservationErrorResponse("RESERVATIONS_UNAVAILABLE", "Configuração indisponível.", requestId, 503);
    return NextResponse.json(reservationSettingsResponseSchema.parse({
      data: { holdHours: row.data.hold_hours, pickupHours: row.data.pickup_hours }, request_id: requestId,
    }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return reservationErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return reservationErrorResponse("RESERVATIONS_UNAVAILABLE", "Configuração indisponível.", requestId, 503);
  }
}

export async function PUT(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = reservationSettingsSchema.safeParse(await request.json().catch(() => null));
  if (!key.success || !parsed.success) return reservationErrorResponse("INVALID_REQUEST", "Informe prazos entre 1 e 720 horas.", requestId, 422);
  try {
    await requirePermission("reservations.manage.all");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("update_reservation_settings", {
      p_hold_hours: parsed.data.holdHours, p_pickup_hours: parsed.data.pickupHours,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return reservationDatabaseError(error.message, requestId);
    const row = databaseSettingsSchema.safeParse(data);
    if (!row.success) return reservationErrorResponse("RESERVATIONS_UNAVAILABLE", "Configuração indisponível.", requestId, 503);
    return NextResponse.json(reservationSettingsResponseSchema.parse({
      data: { holdHours: row.data.hold_hours, pickupHours: row.data.pickup_hours }, request_id: requestId,
    }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return reservationErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return reservationErrorResponse("RESERVATIONS_UNAVAILABLE", "Configuração indisponível.", requestId, 503);
  }
}
