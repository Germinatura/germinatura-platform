import { idempotencyKeySchema, openSellerShiftRequestSchema, sellerShiftResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseShiftSchema, shiftDatabaseError, shiftErrorResponse, toSellerShift } from "@/lib/seller-shift";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });

/** Current open shift of the seller ("Meu turno"), or null. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("sales.create");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("get_my_seller_shift");
    if (error) return shiftDatabaseError(error.message, requestId);
    const shift = data === null ? null : databaseShiftSchema.safeParse(data);
    if (shift && !shift.success) return shiftErrorResponse("SHIFT_INVALID_DATA", "Turno temporariamente indisponível.", requestId, 503);
    return NextResponse.json(sellerShiftResponseSchema.parse({ data: shift ? toSellerShift(shift.data) : null, request_id: requestId }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return shiftErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return shiftErrorResponse("SHIFT_UNAVAILABLE", "Turno temporariamente indisponível.", requestId, 503);
  }
}

/** Opens the seller shift with an optional opening cash float. */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = openSellerShiftRequestSchema.safeParse(await request.json().catch(() => null));
  if (!key.success || !parsed.success) return shiftErrorResponse("INVALID_REQUEST", "Informe o local e o fundo de troco.", requestId, 422);
  try {
    await requirePermission("sales.create");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("open_seller_shift", {
      p_location_id: parsed.data.locationId, p_opening_cash_cents: parsed.data.openingCashCents,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return shiftDatabaseError(error.message, requestId);
    const shift = databaseShiftSchema.safeParse(data);
    if (!shift.success) return shiftErrorResponse("SHIFT_INVALID_DATA", "Turno temporariamente indisponível.", requestId, 503);
    return NextResponse.json(sellerShiftResponseSchema.parse({ data: toSellerShift(shift.data), request_id: requestId }), { status: 201, headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return shiftErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return shiftErrorResponse("SHIFT_UNAVAILABLE", "Turno temporariamente indisponível.", requestId, 503);
  }
}
