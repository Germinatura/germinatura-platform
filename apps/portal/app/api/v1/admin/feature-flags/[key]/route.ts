import { createApiError, featureFlagKeySchema, featureFlagSchema, featureFlagUpdateRequestSchema, featureFlagUpdateResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

export async function PATCH(request: Request, context: { params: Promise<{ key: string }> }) {
  const requestId = createRequestId(request.headers);
  const key = featureFlagKeySchema.safeParse((await context.params).key);
  const body = featureFlagUpdateRequestSchema.safeParse(await request.json().catch(() => null));
  if (!key.success || !body.success) return NextResponse.json(createApiError("INVALID_FEATURE_FLAG_CHANGE", "Alteração de flag inválida", requestId, body.success ? undefined : body.error.issues), { status: 422 });
  try { await requirePermission("admin.access"); } catch (error) {
    const status = error instanceof AuthorizationError ? error.status : 503;
    return NextResponse.json(createApiError(status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", "Permissão insuficiente", requestId), { status });
  }
  const client = await createAuthenticatedSupabaseClient(request);
  const { error } = await client.rpc("update_feature_flag", {
    p_key: key.data, p_enabled: body.data.enabled, p_reason: body.data.reason, p_correlation_id: crypto.randomUUID(),
  });
  if (error) return NextResponse.json(createApiError("FEATURE_FLAG_UPDATE_FAILED", "A flag não pôde ser alterada", requestId), { status: error.message.includes("NOT_FOUND") ? 404 : 503 });
  const result = await client.from("feature_flags").select("key, description, enabled, updated_at, updated_by").eq("key", key.data).single();
  if (result.error) return NextResponse.json(createApiError("FEATURE_FLAG_UPDATE_FAILED", "A flag não pôde ser consultada", requestId), { status: 503 });
  const data = featureFlagSchema.parse({ key: result.data.key, description: result.data.description, enabled: result.data.enabled, updatedAt: result.data.updated_at, updatedBy: result.data.updated_by });
  return NextResponse.json(featureFlagUpdateResponseSchema.parse({ data, request_id: requestId }), { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
}
