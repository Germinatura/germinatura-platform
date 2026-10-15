import { adminMasterUpdateRequestSchema, createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { cohortAdminFailure, requireAdminMaster } from "@/lib/cohort-admin";

interface RouteContext { params: Promise<{ id: string }>; }

/** ADR 0011: grants or revokes ADMIN_MASTER (only another ADMIN_MASTER; the last active one stays). Global operation. */
export async function PUT(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const id = z.uuid().safeParse((await context.params).id);
  const parsed = adminMasterUpdateRequestSchema.safeParse(await request.json().catch(() => null));
  if (!id.success || !parsed.success) return NextResponse.json(createApiError("INVALID_ADMIN_MASTER_CHANGE", "Revise a alteração.", requestId), { status: 422, headers });
  try {
    await requireAdminMaster();
    const client = await createAuthenticatedSupabaseClient(request);
    const { error } = await client.rpc("set_admin_master", {
      p_user_id: id.data, p_granted: parsed.data.granted, p_reason: parsed.data.reason, p_correlation_id: crypto.randomUUID(),
    });
    if (error) throw error;
    return NextResponse.json({ data: { userId: id.data, adminMaster: parsed.data.granted }, request_id: requestId }, { headers });
  } catch (error) {
    return cohortAdminFailure(error, requestId, "Não foi possível alterar o ADMIN_MASTER.");
  }
}
