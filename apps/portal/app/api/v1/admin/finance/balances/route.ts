import { financeBalancesQuerySchema, financeBalancesResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseBalancesSchema, toBalances, treasuryDatabaseError, treasuryErrorResponse } from "@/lib/finance-treasury";

/** Spec 5.8 (FIN-002): treasury balances on a São Paulo day (today by default), from the single database authority. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("finance.manage");
    const query = financeBalancesQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return treasuryErrorResponse("INVALID_REQUEST", "Informe um dia válido.", requestId, 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("finance_balances", { p_as_of: query.data.asOf ?? null });
    if (error) return treasuryDatabaseError(error.message, requestId);
    const row = databaseBalancesSchema.safeParse(data);
    if (!row.success) return treasuryErrorResponse("FINANCE_UNAVAILABLE", "Saldo temporariamente indisponível.", requestId, 503);
    return NextResponse.json(financeBalancesResponseSchema.parse({ data: toBalances(row.data), request_id: requestId }),
      { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return treasuryErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return treasuryErrorResponse("FINANCE_UNAVAILABLE", "Saldo temporariamente indisponível.", requestId, 503);
  }
}
