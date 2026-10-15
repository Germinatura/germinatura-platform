import { financeOverviewResponseSchema, managementIndicatorsQuerySchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { financeHistoryDatabaseError, financeHistoryErrorResponse, financeHistoryFailure, toFinanceOverview } from "@/lib/finance-history";

/**
 * PR E: the financial overview of a period — position, receivables, payables, result (official, presentation, COGS
 * visibility, historical × native), counterparts, goal and the result → cash bridge.
 */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  const query = managementIndicatorsQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return financeHistoryErrorResponse("INVALID_FINANCE_QUERY", "Informe um período válido.", requestId, 422);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("finance_overview", { p_from: query.data.from, p_to: query.data.to });
    if (error) return financeHistoryDatabaseError(error.message, requestId);
    return NextResponse.json(financeOverviewResponseSchema.parse({ data: toFinanceOverview(data), request_id: requestId }),
      { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    return financeHistoryFailure(error, requestId);
  }
}
