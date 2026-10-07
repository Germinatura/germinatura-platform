import { picpayTransactionsQuerySchema, picpayTransactionsResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseTransactionSchema, picpayDatabaseError, picpayErrorResponse, toTransaction } from "@/lib/picpay-reconciliation";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });

/** Transactions of Minhas vendas in a period, with status, real fees, cutover side and PDV link. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("finance.manage");
    const query = picpayTransactionsQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return picpayErrorResponse("INVALID_REQUEST", "Informe um período válido.", requestId, 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_picpay_transactions", {
      p_from: query.data.from, p_to: query.data.to, p_status: query.data.status ?? null, p_unlinked_only: query.data.unlinked === "true", p_limit: 500,
    });
    if (error) return picpayDatabaseError(error.message, requestId);
    const rows = z.array(databaseTransactionSchema).safeParse(data);
    if (!rows.success) return picpayErrorResponse("PICPAY_UNAVAILABLE", "Transações temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(picpayTransactionsResponseSchema.parse({ data: rows.data.map(toTransaction), request_id: requestId }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return picpayErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return picpayErrorResponse("PICPAY_UNAVAILABLE", "Transações temporariamente indisponíveis.", requestId, 503);
  }
}
