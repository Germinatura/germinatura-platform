import { createApiError, idempotencyKeySchema, raffleNumberReservationRequestSchema, raffleNumberReservationResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const paramsSchema = z.object({ id: z.uuid() });
const resultSchema = z.object({ campaign_id: z.uuid(), numbers: z.array(z.number().int()), status: z.literal("RESERVED"),
  sale_id: z.uuid(), sale_status: z.literal("AWAITING_PAYMENT"), payment_attempt_id: z.uuid(),
  total_cents: z.number().int().nonnegative(), expires_at: z.string(), correlation_id: z.uuid() });
const fail = (code: string, message: string, requestId: string, status: number) => NextResponse.json(
  createApiError(code, message, requestId), { status, headers: { "Cache-Control": "no-store", "x-request-id": requestId } },
);
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const params = paramsSchema.safeParse(await context.params);
  let body: unknown; try { body = await request.json(); } catch { return fail("INVALID_BODY", "Corpo JSON inválido", requestId, 422); }
  const parsed = raffleNumberReservationRequestSchema.safeParse(body);
  if (!key.success || !params.success || !parsed.success) return fail("INVALID_RAFFLE_RESERVATION", "Reserva de números inválida", requestId, 422);
  try { await requirePermission("raffles.buy"); } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return fail("RAFFLE_UNAVAILABLE", "Rifa temporariamente indisponível", requestId, 503);
  }
  const correlationId = crypto.randomUUID(); const supabase = await createAuthenticatedSupabaseClient(request);
  const { data, error } = await supabase.rpc("reserve_raffle_numbers", { p_campaign_id: params.data.id,
    p_numbers: parsed.data.numbers, p_idempotency_key: key.data, p_correlation_id: correlationId });
  if (error) {
    if (error.message.includes("RAFFLE_NUMBER_CONFLICT")) return fail("RAFFLE_NUMBER_CONFLICT", "Um ou mais números já foram reservados", requestId, 409);
    if (error.message.includes("NOT_AVAILABLE")) return fail("RAFFLE_NOT_AVAILABLE", "Campanha indisponível", requestId, 409);
    return fail("RAFFLE_UNAVAILABLE", "Rifa temporariamente indisponível", requestId, 503);
  }
  const result = resultSchema.safeParse(data); if (!result.success) return fail("RAFFLE_INVALID_DATA", "Rifa temporariamente indisponível", requestId, 503);
  const value = result.data;
  return NextResponse.json(raffleNumberReservationResponseSchema.parse({ data: {
    campaignId: value.campaign_id, numbers: value.numbers, status: value.status, saleId: value.sale_id,
    saleStatus: value.sale_status, paymentAttemptId: value.payment_attempt_id, totalCents: value.total_cents,
    expiresAt: value.expires_at, correlationId: value.correlation_id,
  }, request_id: requestId }), { status: 201, headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
}
