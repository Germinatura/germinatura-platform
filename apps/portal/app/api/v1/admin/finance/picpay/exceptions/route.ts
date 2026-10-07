import { picpayExceptionsQuerySchema, picpayExceptionsResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseExceptionSchema, picpayDatabaseError, picpayErrorResponse, toException } from "@/lib/picpay-reconciliation";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });

/** Open (or all) reconciliation exceptions of a period. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("finance.manage");
    const query = picpayExceptionsQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return picpayErrorResponse("INVALID_REQUEST", "Informe um período válido.", requestId, 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_picpay_exceptions", {
      p_from: query.data.from, p_to: query.data.to, p_type: query.data.type ?? null, p_include_resolved: query.data.resolved === "true",
    });
    if (error) return picpayDatabaseError(error.message, requestId);
    const rows = z.array(databaseExceptionSchema).safeParse(data);
    if (!rows.success) return picpayErrorResponse("PICPAY_UNAVAILABLE", "Pendências temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(picpayExceptionsResponseSchema.parse({ data: rows.data.map(toException), request_id: requestId }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return picpayErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return picpayErrorResponse("PICPAY_UNAVAILABLE", "Pendências temporariamente indisponíveis.", requestId, 503);
  }
}
