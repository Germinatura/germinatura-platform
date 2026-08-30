import {
  createApiError,
  idempotencyKeySchema,
  salesCheckoutRequestSchema,
  salesCheckoutResponseSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission, requireSession } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const internalPromotionSchema = z.object({
  promotion_id: z.uuid(),
  type: z.literal("QUANTIDADE_PRECO"),
  priority: z.number().int(),
  group_quantity: z.number().int().min(2),
  group_price_cents: z.number().int().nonnegative(),
  max_groups_per_line: z.number().int().positive().nullable(),
  groups: z.number().int().positive(),
  promoted_quantity: z.number().int().positive(),
  remainder_quantity: z.number().int().nonnegative(),
  savings_cents: z.number().int().nonnegative(),
});

const checkoutDatabaseResultSchema = z.object({
  sale_id: z.uuid(),
  status: z.literal("AWAITING_PAYMENT"),
  channel: z.enum(["PORTAL", "PDV"]),
  location_id: z.uuid(),
  quote: z.object({
    quoted_at: z.string(),
    currency: z.literal("BRL"),
    rounding: z.literal("NONE"),
    lines: z.array(z.object({
      product_id: z.uuid(),
      product_sku: z.string(),
      product_name: z.string(),
      quantity: z.number().int().positive(),
      unit_price_cents: z.number().int().nonnegative(),
      original_subtotal_cents: z.number().int().nonnegative(),
      discount_cents: z.number().int().nonnegative(),
      total_cents: z.number().int().nonnegative(),
      promotion_id: z.uuid().nullable(),
      promotion_snapshot: internalPromotionSchema.nullable(),
    })),
    original_total_cents: z.number().int().nonnegative(),
    discount_total_cents: z.number().int().nonnegative(),
    total_cents: z.number().int().nonnegative(),
  }),
  reservation: z.object({
    reservation_id: z.uuid(),
    status: z.literal("ACTIVE"),
    expires_at: z.string(),
    reservation_movement_id: z.uuid(),
  }),
  payment_attempt: z.object({
    attempt_id: z.uuid(),
    status: z.literal("CREATED"),
    amount_cents: z.number().int().nonnegative(),
    integration_channel: z.null(),
    confirmation_source: z.null(),
  }),
  correlation_id: z.uuid(),
});

function errorResponse(code: string, message: string, requestId: string, status: number, details?: unknown) {
  return NextResponse.json(createApiError(code, message, requestId, details), {
    status,
    headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}

async function authenticatedClient(request: Request): Promise<SupabaseClient> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return createSupabaseServerClient();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase public environment is not configured");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { headers: { Authorization: authorization } },
  });
}

function databaseErrorResponse(message: string, requestId: string) {
  if (message.includes("IDEMPOTENCY_CONFLICT")) {
    return errorResponse("IDEMPOTENCY_CONFLICT", "A chave já foi usada com outro conteúdo", requestId, 409);
  }
  if (message.includes("IDEMPOTENCY_IN_PROGRESS")) {
    return errorResponse("IDEMPOTENCY_IN_PROGRESS", "A cobrança já está em processamento", requestId, 409);
  }
  if (message.includes("STOCK_CONFLICT")) {
    return errorResponse("STOCK_CONFLICT", "Estoque insuficiente para concluir a cobrança", requestId, 409);
  }
  if (message.includes("SALE_LOCATION_FORBIDDEN")) {
    return errorResponse("FORBIDDEN", "Localização não autorizada", requestId, 403);
  }
  if (message.includes("PRODUCT_UNAVAILABLE") || message.includes("INVALID_SALE_ITEMS")) {
    return errorResponse("INVALID_CHECKOUT", "Um ou mais itens não estão disponíveis", requestId, 422);
  }
  return errorResponse("CHECKOUT_UNAVAILABLE", "Cobrança temporariamente indisponível", requestId, 503);
}

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const idempotency = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!idempotency.success) {
    return errorResponse("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key inválida ou ausente", requestId, 422);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_BODY", "Corpo JSON inválido", requestId, 422);
  }
  const parsed = salesCheckoutRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_CHECKOUT", "Solicitação de cobrança inválida", requestId, 422, parsed.error.issues);
  }

  try {
    if (parsed.data.channel === "PDV") await requirePermission("sales.create");
    else await requireSession();
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return errorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    }
    return errorResponse("CHECKOUT_UNAVAILABLE", "Cobrança temporariamente indisponível", requestId, 503);
  }

  const correlationId = crypto.randomUUID();
  let supabase: SupabaseClient;
  try {
    supabase = await authenticatedClient(request);
  } catch {
    return errorResponse("CHECKOUT_UNAVAILABLE", "Cobrança temporariamente indisponível", requestId, 503);
  }
  const { data, error } = await supabase.rpc("checkout_sale", {
    p_channel: parsed.data.channel,
    p_location_id: parsed.data.locationId,
    p_items: parsed.data.items.map((item) => ({ product_id: item.productId, quantity: item.quantity })),
    p_idempotency_key: idempotency.data,
    p_correlation_id: correlationId,
  });
  if (error) return databaseErrorResponse(error.message, requestId);

  const result = checkoutDatabaseResultSchema.safeParse(data);
  if (!result.success) {
    return errorResponse("CHECKOUT_INVALID_DATA", "Cobrança temporariamente indisponível", requestId, 503);
  }
  const value = result.data;
  const response = salesCheckoutResponseSchema.parse({
    data: {
      saleId: value.sale_id,
      status: value.status,
      channel: value.channel,
      locationId: value.location_id,
      quote: {
        channel: value.channel,
        quotedAt: value.quote.quoted_at,
        currency: value.quote.currency,
        rounding: value.quote.rounding,
        lines: value.quote.lines.map((line) => ({
          productId: line.product_id,
          name: line.product_name,
          unitPriceCents: line.unit_price_cents,
          quantity: line.quantity,
          originalSubtotalCents: line.original_subtotal_cents,
          discountCents: line.discount_cents,
          totalCents: line.total_cents,
          appliedPromotion: line.promotion_snapshot && {
            promotionId: line.promotion_snapshot.promotion_id,
            type: line.promotion_snapshot.type,
            groupQuantity: line.promotion_snapshot.group_quantity,
            groupPriceCents: line.promotion_snapshot.group_price_cents,
            groups: line.promotion_snapshot.groups,
            promotedQuantity: line.promotion_snapshot.promoted_quantity,
            remainderQuantity: line.promotion_snapshot.remainder_quantity,
            savingsCents: line.promotion_snapshot.savings_cents,
          },
        })),
        originalTotalCents: value.quote.original_total_cents,
        discountTotalCents: value.quote.discount_total_cents,
        totalCents: value.quote.total_cents,
      },
      reservation: {
        reservationId: value.reservation.reservation_id,
        status: value.reservation.status,
        expiresAt: value.reservation.expires_at,
        reservationMovementId: value.reservation.reservation_movement_id,
      },
      paymentAttempt: {
        attemptId: value.payment_attempt.attempt_id,
        status: value.payment_attempt.status,
        amountCents: value.payment_attempt.amount_cents,
        integrationChannel: value.payment_attempt.integration_channel,
        confirmationSource: value.payment_attempt.confirmation_source,
      },
      correlationId: value.correlation_id,
    },
    request_id: requestId,
  });
  return NextResponse.json(response, {
    status: 201,
    headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}
