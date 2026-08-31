import {
  commercialReservationCreateRequestSchema,
  commercialReservationCreateResponseSchema,
  createApiError,
  idempotencyKeySchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requireSession } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const promotionSchema = z.object({
  promotion_id: z.uuid(), type: z.literal("QUANTIDADE_PRECO"), priority: z.number().int(),
  group_quantity: z.number().int(), group_price_cents: z.number().int(),
  max_groups_per_line: z.number().int().nullable(), groups: z.number().int(),
  promoted_quantity: z.number().int(), remainder_quantity: z.number().int(), savings_cents: z.number().int(),
});
const resultSchema = z.object({
  reservation_id: z.uuid(),
  status: z.literal("ACTIVE"),
  location_id: z.uuid(),
  quote: z.object({
    quoted_at: z.string(), currency: z.literal("BRL"), rounding: z.literal("NONE"),
    lines: z.array(z.object({
      product_id: z.uuid(), product_name: z.string(), quantity: z.number().int().positive(),
      unit_price_cents: z.number().int().nonnegative(),
      original_subtotal_cents: z.number().int().nonnegative(),
      discount_cents: z.number().int().nonnegative(), total_cents: z.number().int().nonnegative(),
      promotion_snapshot: promotionSchema.nullable(),
    })),
    original_total_cents: z.number().int().nonnegative(),
    discount_total_cents: z.number().int().nonnegative(), total_cents: z.number().int().nonnegative(),
  }),
  stock_reservation: z.object({
    reservation_id: z.uuid(), status: z.literal("ACTIVE"), expires_at: z.string(),
    reservation_movement_id: z.uuid(),
  }),
  correlation_id: z.uuid(),
});

function response(code: string, message: string, requestId: string, status: number, details?: unknown) {
  return NextResponse.json(createApiError(code, message, requestId, details), {
    status, headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!key.success) return response("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key inválida ou ausente", requestId, 422);
  let body: unknown;
  try { body = await request.json(); } catch { return response("INVALID_BODY", "Corpo JSON inválido", requestId, 422); }
  const parsed = commercialReservationCreateRequestSchema.safeParse(body);
  if (!parsed.success) return response("INVALID_RESERVATION", "Reserva inválida", requestId, 422, parsed.error.issues);
  try { await requireSession(); } catch (error) {
    if (error instanceof AuthorizationError) return response(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return response("RESERVATION_UNAVAILABLE", "Reserva temporariamente indisponível", requestId, 503);
  }
  const correlationId = crypto.randomUUID();
  const supabase = await createAuthenticatedSupabaseClient(request);
  const { data, error } = await supabase.rpc("create_commercial_reservation", {
    p_location_id: parsed.data.locationId,
    p_items: parsed.data.items.map((item) => ({ product_id: item.productId, quantity: item.quantity })),
    p_idempotency_key: key.data, p_correlation_id: correlationId,
  });
  if (error) {
    if (error.message.includes("IDEMPOTENCY_CONFLICT")) return response("IDEMPOTENCY_CONFLICT", "A chave já foi usada com outro conteúdo", requestId, 409);
    if (error.message.includes("STOCK_CONFLICT")) return response("STOCK_CONFLICT", "Estoque insuficiente", requestId, 409);
    if (error.message.includes("FORBIDDEN")) return response("FORBIDDEN", "Reserva não autorizada", requestId, 403);
    return response("RESERVATION_UNAVAILABLE", "Reserva temporariamente indisponível", requestId, 503);
  }
  const result = resultSchema.safeParse(data);
  if (!result.success) return response("RESERVATION_INVALID_DATA", "Reserva temporariamente indisponível", requestId, 503);
  const value = result.data;
  const payload = commercialReservationCreateResponseSchema.parse({
    data: {
      reservationId: value.reservation_id, status: value.status, locationId: value.location_id,
      quote: {
        channel: "PORTAL", quotedAt: value.quote.quoted_at, currency: value.quote.currency,
        rounding: value.quote.rounding,
        lines: value.quote.lines.map((line) => ({
          productId: line.product_id, name: line.product_name, unitPriceCents: line.unit_price_cents,
          quantity: line.quantity, originalSubtotalCents: line.original_subtotal_cents,
          discountCents: line.discount_cents, totalCents: line.total_cents,
          appliedPromotion: line.promotion_snapshot && {
            promotionId: line.promotion_snapshot.promotion_id, type: line.promotion_snapshot.type,
            groupQuantity: line.promotion_snapshot.group_quantity,
            groupPriceCents: line.promotion_snapshot.group_price_cents,
            groups: line.promotion_snapshot.groups, promotedQuantity: line.promotion_snapshot.promoted_quantity,
            remainderQuantity: line.promotion_snapshot.remainder_quantity,
            savingsCents: line.promotion_snapshot.savings_cents,
          },
        })),
        originalTotalCents: value.quote.original_total_cents,
        discountTotalCents: value.quote.discount_total_cents, totalCents: value.quote.total_cents,
      },
      stockReservation: {
        reservationId: value.stock_reservation.reservation_id, status: value.stock_reservation.status,
        expiresAt: value.stock_reservation.expires_at,
        reservationMovementId: value.stock_reservation.reservation_movement_id,
      }, correlationId: value.correlation_id,
    }, request_id: requestId,
  });
  return NextResponse.json(payload, { status: 201, headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
}
