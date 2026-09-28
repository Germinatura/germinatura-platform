import { adminSellerShiftsQuerySchema, adminSellerShiftsResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseAdminShiftSchema, shiftErrorResponse, toAdminSellerShift } from "@/lib/seller-shift";

/** PAY-009a: finance review of seller shifts, open drawers first. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("finance.manage");
    const parsed = adminSellerShiftsQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return shiftErrorResponse("INVALID_SHIFT_QUERY", "Consulta de turnos inválida.", requestId, 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_seller_shifts", { p_status: parsed.data.status ?? null, p_limit: 100 });
    const rows = z.array(databaseAdminShiftSchema).safeParse(data);
    if (error || !rows.success) return shiftErrorResponse("SHIFT_UNAVAILABLE", "Não foi possível consultar os turnos.", requestId, 503);
    const response = adminSellerShiftsResponseSchema.parse({ data: rows.data.map(toAdminSellerShift), request_id: requestId });
    return NextResponse.json(response, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return shiftErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    }
    return shiftErrorResponse("SHIFT_UNAVAILABLE", "Não foi possível consultar os turnos.", requestId, 503);
  }
}
