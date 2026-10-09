import { consolidatedIndicatorsResponseSchema, createApiError, managementIndicatorsQuerySchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { createSupabaseClientInCohort } from "@/lib/authenticated-supabase";
import { cohortAdminFailure, requireAdminMaster } from "@/lib/cohort-admin";
import { loadManagementIndicators } from "@/lib/management-indicators";

/**
 * ADR 0011 (PR 4): the period indicators of each cohort, computed inside that cohort and returned side by side
 * (ADMIN_MASTER). Nothing is added across cohorts here; a cohort that cannot be computed comes back without figures.
 */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const url = new URL(request.url);
  const query = managementIndicatorsQuerySchema.safeParse({ from: url.searchParams.get("from"), to: url.searchParams.get("to") });
  if (!query.success) return NextResponse.json(createApiError("INVALID_PERIOD", "Período inválido.", requestId), { status: 422, headers });
  try {
    const user = await requireAdminMaster();
    const cohorts = await Promise.all(user.cohorts.map(async (cohort) => {
      const client = await createSupabaseClientInCohort(request, cohort.id);
      const indicators = await loadManagementIndicators(client, query.data.from, query.data.to).catch(() => null);
      return { cohortId: cohort.id, name: cohort.name, status: cohort.status, indicators };
    }));
    return NextResponse.json(consolidatedIndicatorsResponseSchema.parse({
      data: { from: query.data.from, to: query.data.to, cohorts }, request_id: requestId,
    }), { headers });
  } catch (error) {
    return cohortAdminFailure(error, requestId, "Não foi possível comparar as turmas.");
  }
}
