import { createApiError, featureFlagsResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requireSession } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try { await requireSession(); } catch (error) {
    const status = error instanceof AuthorizationError ? error.status : 503;
    return NextResponse.json(createApiError(status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", "Acesso não autorizado", requestId), { status });
  }
  const client = await createAuthenticatedSupabaseClient(request);
  const { data, error } = await client.from("feature_flags").select("key, description, enabled, updated_at, updated_by").order("key");
  if (error) return NextResponse.json(createApiError("FEATURE_FLAGS_UNAVAILABLE", "Flags temporariamente indisponíveis", requestId), { status: 503 });
  const payload = featureFlagsResponseSchema.parse({
    data: data.map((flag) => ({ key: flag.key, description: flag.description, enabled: flag.enabled, updatedAt: flag.updated_at, updatedBy: flag.updated_by })),
    request_id: requestId,
  });
  return NextResponse.json(payload, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
}
