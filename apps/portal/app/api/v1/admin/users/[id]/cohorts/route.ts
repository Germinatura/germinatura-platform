import { userCohortMembershipsResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { cohortAdminFailure, requireAdminMaster, toUserCohortMemberships } from "@/lib/cohort-admin";

interface RouteContext { params: Promise<{ id: string }>; }

/** ADR 0011 (PR 4): every cohort of one person — membership, roles per cohort and what blocks deactivating (ADMIN_MASTER). */
export async function GET(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return cohortAdminFailure({ message: "USER_NOT_FOUND" }, requestId, "Pessoa não encontrada.");
  try {
    await requireAdminMaster();
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("user_cohort_memberships", { p_user_id: id.data });
    if (error) throw error;
    return NextResponse.json(userCohortMembershipsResponseSchema.parse({ data: toUserCohortMemberships(data), request_id: requestId }), { headers });
  } catch (error) {
    return cohortAdminFailure(error, requestId, "Não foi possível consultar as turmas da pessoa.");
  }
}
