import { createApiError, membershipUpdateRequestSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { cohortAdminFailure } from "@/lib/cohort-admin";

interface RouteContext { params: Promise<{ id: string }>; }

/**
 * ADR 0011 (PR 4): adds, deactivates or reactivates the person's membership in the request cohort — a concrete cohort
 * chosen explicitly (never "all"; the proxy refuses it). A cohort ADMIN changes only people of the cohort; bringing a
 * new person in belongs to ADMIN_MASTER. Deactivating waits while the person has open work there; audited.
 */
export async function PUT(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const id = z.uuid().safeParse((await context.params).id);
  const parsed = membershipUpdateRequestSchema.safeParse(await request.json().catch(() => null));
  if (!id.success || !parsed.success) {
    return NextResponse.json(createApiError("INVALID_MEMBERSHIP", "Revise a alteração do vínculo.", requestId), { status: 422, headers });
  }
  try {
    await requirePermission("users.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("set_cohort_membership", {
      p_user_id: id.data, p_active: parsed.data.active, p_reason: parsed.data.reason, p_correlation_id: crypto.randomUUID(),
    });
    if (error) throw error;
    return NextResponse.json({ data, request_id: requestId }, { headers });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return NextResponse.json(createApiError(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId), { status: error.status, headers });
    }
    return cohortAdminFailure(error, requestId, "Não foi possível alterar o vínculo.");
  }
}
