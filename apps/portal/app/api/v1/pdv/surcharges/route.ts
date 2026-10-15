import { paymentSurchargeRulesResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseSurchargeRulesSchema, surchargeErrorResponse, toSurchargeRules } from "@/lib/payment-surcharges";

/** PR D: the acréscimo rules in force, so the PDV shows the total before charging (the server recomputes it). */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("sales.create");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_payment_surcharge_rules");
    if (error?.message.includes("COHORT_REQUIRED")) return surchargeErrorResponse("COHORT_REQUIRED", "Selecione uma turma.", requestId, 409);
    const rows = databaseSurchargeRulesSchema.safeParse(data);
    if (error || !rows.success) return surchargeErrorResponse("SURCHARGES_UNAVAILABLE", "Acréscimos temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(paymentSurchargeRulesResponseSchema.parse({ data: { ...toSurchargeRules(rows.data), history: null }, request_id: requestId }),
      { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return surchargeErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return surchargeErrorResponse("SURCHARGES_UNAVAILABLE", "Acréscimos temporariamente indisponíveis.", requestId, 503);
  }
}
