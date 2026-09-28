import { closeSellerShiftRequestSchema, idempotencyKeySchema, sellerShiftResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseShiftSchema, shiftDatabaseError, shiftErrorResponse, toSellerShift } from "@/lib/seller-shift";

interface RouteContext { params: Promise<{ id: string }>; }

/** Closes the seller shift with the counted cash; a divergence needs a justification. */
export async function POST(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = closeSellerShiftRequestSchema.safeParse(await request.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !key.success || !parsed.success) {
    return shiftErrorResponse("INVALID_REQUEST", "Informe o valor contado e, se houver diferença, a justificativa.", requestId, 422);
  }
  try {
    await requirePermission("sales.create");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("close_seller_shift", {
      p_shift_id: id, p_counted_cash_cents: parsed.data.countedCashCents, p_justification: parsed.data.justification,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return shiftDatabaseError(error.message, requestId);
    const shift = databaseShiftSchema.safeParse(data);
    if (!shift.success) return shiftErrorResponse("SHIFT_INVALID_DATA", "Turno temporariamente indisponível.", requestId, 503);
    return NextResponse.json(sellerShiftResponseSchema.parse({ data: toSellerShift(shift.data), request_id: requestId }),
      { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return shiftErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return shiftErrorResponse("SHIFT_UNAVAILABLE", "Turno temporariamente indisponível.", requestId, 503);
  }
}
