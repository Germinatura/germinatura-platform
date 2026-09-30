import { createApiError, managementIndicatorsQuerySchema, managementIndicatorsResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { IndicatorsError, loadManagementIndicators } from "@/lib/management-indicators";

/** ADMIN-001: management indicators of a São Paulo period, derived from the ledgers. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const fail = (code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers });
  const query = managementIndicatorsQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return fail("INVALID_INDICATORS_PERIOD", "Informe um período válido de até um ano.", 422);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const data = await loadManagementIndicators(client, query.data.from, query.data.to);
    return NextResponse.json(managementIndicatorsResponseSchema.parse({ data, request_id: requestId }), { headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    if (error instanceof IndicatorsError && error.code === "FORBIDDEN") return fail("FORBIDDEN", "Somente o financeiro vê os indicadores.", 403);
    if (error instanceof IndicatorsError && error.code === "INVALID_PERIOD") return fail("INVALID_INDICATORS_PERIOD", "Informe um período válido de até um ano.", 422);
    return fail("INDICATORS_UNAVAILABLE", "Indicadores temporariamente indisponíveis.", 503);
  }
}
