import { createApiError, idempotencyKeySchema, raffleCampaignResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
const paramsSchema = z.object({ id: z.uuid() });
const resultSchema = z.object({ campaign_id: z.uuid(), status: z.literal("CLOSED"), correlation_id: z.uuid() });
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = createRequestId(request.headers); const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const params = paramsSchema.safeParse(await context.params);
  const fail = (code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  if (!key.success || !params.success) return fail("INVALID_RAFFLE_CLOSE", "Fechamento inválido", 422);
  try { await requirePermission("raffles.manage"); } catch (error) { if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status); return fail("RAFFLE_UNAVAILABLE", "Rifa temporariamente indisponível", 503); }
  const supabase = await createAuthenticatedSupabaseClient(request); const { data, error } = await supabase.rpc("close_raffle_campaign", {
    p_campaign_id: params.data.id, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
  });
  if (error) return fail(error.message.includes("PENDING_RESERVATIONS") ? "RAFFLE_PENDING_RESERVATIONS" : "RAFFLE_UNAVAILABLE",
    error.message.includes("PENDING_RESERVATIONS") ? "A campanha possui reservas pendentes" : "Rifa temporariamente indisponível", error.message.includes("PENDING_RESERVATIONS") ? 409 : 503);
  const result = resultSchema.safeParse(data); if (!result.success) return fail("RAFFLE_INVALID_DATA", "Rifa temporariamente indisponível", 503);
  return NextResponse.json(raffleCampaignResponseSchema.parse({ data: { campaignId: result.data.campaign_id,
    status: result.data.status, correlationId: result.data.correlation_id }, request_id: requestId }), { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
}
