import { createApiError, idempotencyKeySchema, pdvRaffleReservationRequestSchema, raffleNumberReservationResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const resultSchema = z.object({ campaign_id: z.uuid(), numbers: z.array(z.number().int()), status: z.literal("RESERVED"),
  sale_id: z.uuid(), sale_status: z.literal("AWAITING_PAYMENT"), payment_attempt_id: z.uuid(),
  total_cents: z.number().int().nonnegative(), expires_at: z.string(), correlation_id: z.uuid() });

/** Spec 6.15: the seller reserves raffle numbers for an identified buyer; payment follows the usual PDV flow. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const fail = (code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers });
  const campaignId = z.uuid().safeParse((await context.params).id);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = pdvRaffleReservationRequestSchema.safeParse(await request.json().catch(() => null));
  if (!campaignId.success || !key.success || !parsed.success) return fail("INVALID_RAFFLE_SALE", "Confira os números e o comprador", 422);
  try {
    await requirePermission("raffles.sell");
    const client = await createAuthenticatedSupabaseClient(request);
    const buyer = parsed.data.buyer;
    const { data, error } = await client.rpc("reserve_raffle_numbers_pdv", {
      p_campaign_id: campaignId.data, p_location_id: parsed.data.locationId, p_numbers: parsed.data.numbers,
      p_buyer_profile_id: "profileId" in buyer ? buyer.profileId : null,
      p_buyer_name: "name" in buyer ? buyer.name : null, p_buyer_contact: "contact" in buyer ? buyer.contact : null,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      if (error.message.includes("RAFFLE_NUMBER_CONFLICT")) return fail("RAFFLE_NUMBER_CONFLICT", "Um ou mais números já foram reservados", 409);
      if (error.message.includes("NOT_AVAILABLE")) return fail("RAFFLE_NOT_AVAILABLE", "A rifa não está aberta para vendas", 409);
      if (error.message.includes("BUYER")) return fail("INVALID_RAFFLE_BUYER", "Identifique o comprador: cadastro ou nome e telefone/e-mail válidos", 422);
      if (error.message.includes("INVALID_")) return fail("INVALID_RAFFLE_SALE", "Confira os números e o comprador", 422);
      if (error.message.includes("FORBIDDEN")) return fail("FORBIDDEN", "Somente vendedores vendem rifas no PDV", 403);
      return fail("RAFFLE_UNAVAILABLE", "Rifa temporariamente indisponível", 503);
    }
    const result = resultSchema.safeParse(data);
    if (!result.success) return fail("RAFFLE_INVALID_DATA", "Rifa temporariamente indisponível", 503);
    const value = result.data;
    return NextResponse.json(raffleNumberReservationResponseSchema.parse({ data: {
      campaignId: value.campaign_id, numbers: value.numbers, status: value.status, saleId: value.sale_id, saleStatus: value.sale_status,
      paymentAttemptId: value.payment_attempt_id, totalCents: value.total_cents, expiresAt: value.expires_at, correlationId: value.correlation_id,
    }, request_id: requestId }), { status: 201, headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("RAFFLE_UNAVAILABLE", "Rifa temporariamente indisponível", 503);
  }
}
