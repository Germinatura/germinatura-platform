import { createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { cohortAdminFailure, requireAdminMaster } from "@/lib/cohort-admin";

interface RouteContext { params: Promise<{ id: string }>; }
const bodySchema = z.object({ reason: z.string().trim().min(4).max(500) }).strict();

/**
 * ADR 0011 (PR 5): ADMIN_MASTER chooses the default cohort — the one visitors see and new sign-ups join. It is never a
 * write fallback. Exactly one, always ACTIVE; concurrent changes are serialized in the database. Global operation.
 */
export async function PUT(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const id = z.uuid().safeParse((await context.params).id);
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!id.success || !body.success) return NextResponse.json(createApiError("INVALID_COHORT", "Informe o motivo da troca.", requestId), { status: 422, headers });
  try {
    await requireAdminMaster();
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("set_default_cohort", { p_cohort_id: id.data, p_reason: body.data.reason, p_correlation_id: crypto.randomUUID() });
    if (error) throw error;
    return NextResponse.json({ data, request_id: requestId }, { headers });
  } catch (error) {
    return cohortAdminFailure(error, requestId, "Não foi possível trocar a turma padrão.");
  }
}
