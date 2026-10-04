import { createApiError, idempotencyKeySchema, raffleDrawResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
const paramsSchema = z.object({ id: z.uuid() });
const resultSchema = z.object({ draw_id: z.uuid(), campaign_id: z.uuid(), eligible_numbers: z.array(z.number().int()),
  random_material: z.string(), audit_hash: z.string(), winner_index: z.number().int(), winner_number: z.number().int(), correlation_id: z.uuid() });
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = createRequestId(request.headers); const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key")); const params = paramsSchema.safeParse(await context.params);
  const fail = (code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  if (!key.success || !params.success) return fail("INVALID_RAFFLE_DRAW", "Sorteio inválido", 422);
  try { await requirePermission("raffles.manage"); } catch (error) { if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status); return fail("RAFFLE_UNAVAILABLE", "Rifa temporariamente indisponível", 503); }
  const supabase = await createAuthenticatedSupabaseClient(request); const { data, error } = await supabase.rpc("draw_raffle_campaign", {
    p_campaign_id: params.data.id, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
  });
  if (error) return fail(error.message.includes("NO_ELIGIBLE") ? "RAFFLE_NO_ELIGIBLE_NUMBERS" : "RAFFLE_NOT_DRAWABLE",
    error.message.includes("NO_ELIGIBLE") ? "Não há números pagos elegíveis" : "Campanha não pode ser sorteada", 409);
  const result = resultSchema.safeParse(data); if (!result.success) return fail("RAFFLE_INVALID_DATA", "Rifa temporariamente indisponível", 503); const value = result.data;
  return NextResponse.json(raffleDrawResponseSchema.parse({ data: { drawId: value.draw_id, campaignId: value.campaign_id,
    eligibleNumbers: value.eligible_numbers, randomMaterial: value.random_material, auditHash: value.audit_hash,
    winnerIndex: value.winner_index, winnerNumber: value.winner_number, correlationId: value.correlation_id }, request_id: requestId }),
    { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
}
