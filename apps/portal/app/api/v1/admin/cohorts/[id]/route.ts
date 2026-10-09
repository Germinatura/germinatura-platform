import { cohortResponseSchema, cohortUpdateRequestSchema, createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { cohortAdminFailure, requireAdminMaster, toCohortSummary } from "@/lib/cohort-admin";

interface RouteContext { params: Promise<{ id: string }>; }

/** Renames a cohort or changes its status, archiving and reactivating included (global operation). */
export async function PATCH(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const id = z.uuid().safeParse((await context.params).id);
  const parsed = cohortUpdateRequestSchema.safeParse(await request.json().catch(() => null));
  if (!id.success || !parsed.success) return NextResponse.json(createApiError("INVALID_COHORT", "Revise os dados da turma.", requestId), { status: 422, headers });
  try {
    await requireAdminMaster();
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("update_cohort", {
      p_cohort_id: id.data, p_name: parsed.data.name, p_status: parsed.data.status, p_reason: parsed.data.reason, p_correlation_id: crypto.randomUUID(),
    });
    if (error) throw error;
    return NextResponse.json(cohortResponseSchema.parse({ data: toCohortSummary(data), request_id: requestId }), { headers });
  } catch (error) {
    return cohortAdminFailure(error, requestId, "Não foi possível alterar a turma.");
  }
}
