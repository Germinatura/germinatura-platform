import { picpayPeriodQuerySchema, picpaySummaryResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseSummarySchema, picpayDatabaseError, picpayErrorResponse, toSummary } from "@/lib/picpay-reconciliation";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });

/** The reconciliation of a São Paulo period across PDV, Minhas vendas, Recebíveis and Extrato, with the balances. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("finance.manage");
    const query = picpayPeriodQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return picpayErrorResponse("INVALID_REQUEST", "Informe um período válido.", requestId, 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("picpay_reconciliation_summary", { p_from: query.data.from, p_to: query.data.to });
    if (error) return picpayDatabaseError(error.message, requestId);
    const row = databaseSummarySchema.safeParse(data);
    if (!row.success) return picpayErrorResponse("PICPAY_UNAVAILABLE", "Resumo temporariamente indisponível.", requestId, 503);
    return NextResponse.json(picpaySummaryResponseSchema.parse({ data: toSummary(row.data), request_id: requestId }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return picpayErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return picpayErrorResponse("PICPAY_UNAVAILABLE", "Resumo temporariamente indisponível.", requestId, 503);
  }
}
