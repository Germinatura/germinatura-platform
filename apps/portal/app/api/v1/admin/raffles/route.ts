import { createApiError, idempotencyKeySchema, raffleCampaignCreateRequestSchema, raffleCampaignResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const resultSchema = z.object({ campaign_id: z.uuid(), status: z.literal("ACTIVE"), number_count: z.number().int(),
  starts_at: z.string(), ends_at: z.string(), correlation_id: z.uuid() });
const fail = (code: string, message: string, requestId: string, status: number, details?: unknown) => NextResponse.json(
  createApiError(code, message, requestId, details), { status, headers: { "Cache-Control": "no-store", "x-request-id": requestId } },
);

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  let body: unknown; try { body = await request.json(); } catch { return fail("INVALID_BODY", "Corpo JSON inválido", requestId, 422); }
  const parsed = raffleCampaignCreateRequestSchema.safeParse(body);
  if (!key.success || !parsed.success) return fail("INVALID_RAFFLE_CAMPAIGN", "Campanha inválida", requestId, 422, parsed.success ? undefined : parsed.error.issues);
  try { await requirePermission("raffles.manage"); } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return fail("RAFFLE_UNAVAILABLE", "Rifa temporariamente indisponível", requestId, 503);
  }
  const correlationId = crypto.randomUUID();
  const supabase = await createAuthenticatedSupabaseClient(request);
  const { data, error } = await supabase.rpc("create_raffle_campaign", {
    p_name: parsed.data.name, p_product_id: parsed.data.productId, p_location_id: parsed.data.locationId,
    p_number_count: parsed.data.numberCount, p_starts_at: parsed.data.startsAt, p_ends_at: parsed.data.endsAt,
    p_idempotency_key: key.data, p_correlation_id: correlationId,
  });
  if (error) return fail(error.message.includes("IDEMPOTENCY_CONFLICT") ? "IDEMPOTENCY_CONFLICT" : "RAFFLE_UNAVAILABLE",
    error.message.includes("IDEMPOTENCY_CONFLICT") ? "A chave já foi usada com outro conteúdo" : "Rifa temporariamente indisponível",
    requestId, error.message.includes("IDEMPOTENCY_CONFLICT") ? 409 : 503);
  const result = resultSchema.safeParse(data);
  if (!result.success) return fail("RAFFLE_INVALID_DATA", "Rifa temporariamente indisponível", requestId, 503);
  const value = result.data;
  return NextResponse.json(raffleCampaignResponseSchema.parse({ data: {
    campaignId: value.campaign_id, status: value.status, numberCount: value.number_count,
    startsAt: value.starts_at, endsAt: value.ends_at, correlationId: value.correlation_id,
  }, request_id: requestId }), { status: 201, headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
}
