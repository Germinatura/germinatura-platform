import { cohortCreateRequestSchema, cohortListResponseSchema, cohortResponseSchema, createApiError, idempotencyKeySchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { cohortAdminFailure, requireAdminMaster, toCohortSummary } from "@/lib/cohort-admin";

/** ADR 0011: every cohort, archived included (ADMIN_MASTER only). */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    const user = await requireAdminMaster();
    return NextResponse.json(cohortListResponseSchema.parse({ data: user.cohorts, request_id: requestId }),
      { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    return cohortAdminFailure(error, requestId, "Não foi possível consultar as turmas.");
  }
}

/** Creates a cohort (global operation; allowed in "Todas as turmas"). */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!key.success) return NextResponse.json(createApiError("IDEMPOTENCY_KEY_REQUIRED", "Chave de idempotência obrigatória.", requestId), { status: 400, headers });
  const parsed = cohortCreateRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json(createApiError("INVALID_COHORT", "Revise os dados da turma.", requestId, parsed.error.issues), { status: 422, headers });
  try {
    await requireAdminMaster();
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("create_cohort", {
      p_name: parsed.data.name, p_year: parsed.data.year, p_slug: parsed.data.slug, p_status: parsed.data.status,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) throw error;
    return NextResponse.json(cohortResponseSchema.parse({ data: toCohortSummary(data), request_id: requestId }), { status: 201, headers });
  } catch (error) {
    return cohortAdminFailure(error, requestId, "Não foi possível criar a turma.");
  }
}
