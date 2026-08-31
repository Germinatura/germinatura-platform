import {
  createApiError,
  idempotencyKeySchema,
  sellerCloseoutRequestSchema,
  sellerCloseoutResponseSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const databaseResultSchema = z.object({
  closeout_id: z.uuid(), seller_id: z.uuid(), location_id: z.uuid(), status: z.literal("CLOSED"),
  period_start: z.string(), period_end: z.string(),
  confirmed_sales_count: z.number().int().nonnegative(), confirmed_sales_total_cents: z.number().int().nonnegative(),
  payment_count: z.number().int().nonnegative(), payment_total_cents: z.number().int().nonnegative(),
  payment_difference_cents: z.number().int(), stock_difference_units: z.number().int().nonnegative(),
  justification: z.string().nullable(), correlation_id: z.uuid(),
  payment_summaries: z.array(z.object({
    integration_channel: z.enum(["PIX_AREA", "CHECKOUT_API", "PICPAY_WALLET", "PAYMENT_LINK", "MAQUININHA", "TAP"]),
    payment_count: z.number().int().nonnegative(), total_cents: z.number().int().nonnegative(),
  })),
  stock_counts: z.array(z.object({
    product_id: z.uuid(), expected_quantity: z.number().int().nonnegative(),
    counted_quantity: z.number().int().nonnegative(), difference_quantity: z.number().int(),
  })),
});

function errorResponse(code: string, message: string, requestId: string, status: number, details?: unknown) {
  return NextResponse.json(createApiError(code, message, requestId, details), {
    status, headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}

function databaseErrorResponse(message: string, requestId: string) {
  if (message.includes("CLOSEOUT_PERIOD_OVERLAP")) return errorResponse("CLOSEOUT_PERIOD_OVERLAP", "Já existe fechamento para parte desse período", requestId, 409);
  if (message.includes("CLOSEOUT_JUSTIFICATION_REQUIRED")) return errorResponse("CLOSEOUT_JUSTIFICATION_REQUIRED", "Divergências exigem justificativa", requestId, 422);
  if (message.includes("INVALID_CLOSEOUT_STOCK_COUNTS")) return errorResponse("INVALID_CLOSEOUT_STOCK_COUNTS", "A contagem deve cobrir todo o estoque da localização", requestId, 422);
  if (message.includes("SELLER_LOCATION_NOT_FOUND")) return errorResponse("SELLER_LOCATION_NOT_FOUND", "Localização ativa do vendedor não encontrada", requestId, 409);
  if (message.includes("IDEMPOTENCY_CONFLICT")) return errorResponse("IDEMPOTENCY_CONFLICT", "A chave já foi usada com outro conteúdo", requestId, 409);
  if (message.includes("IDEMPOTENCY_IN_PROGRESS")) return errorResponse("IDEMPOTENCY_IN_PROGRESS", "O fechamento já está em processamento", requestId, 409);
  return errorResponse("CLOSEOUT_UNAVAILABLE", "Fechamento temporariamente indisponível", requestId, 503);
}

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const idempotency = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!idempotency.success) return errorResponse("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key inválida ou ausente", requestId, 422);
  const parsed = sellerCloseoutRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse("INVALID_CLOSEOUT", "Fechamento inválido", requestId, 422, parsed.error.issues);
  try {
    await requirePermission("closeouts.create");
  } catch (error) {
    if (error instanceof AuthorizationError) return errorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return errorResponse("CLOSEOUT_UNAVAILABLE", "Fechamento temporariamente indisponível", requestId, 503);
  }
  let supabase;
  try { supabase = await createAuthenticatedSupabaseClient(request); }
  catch { return errorResponse("CLOSEOUT_UNAVAILABLE", "Fechamento temporariamente indisponível", requestId, 503); }
  const { data, error } = await supabase.rpc("create_seller_closeout", {
    p_period_start: parsed.data.periodStart,
    p_period_end: parsed.data.periodEnd,
    p_stock_counts: parsed.data.stockCounts.map((item) => ({ product_id: item.productId, counted_quantity: item.countedQuantity })),
    p_justification: parsed.data.justification,
    p_idempotency_key: idempotency.data,
    p_correlation_id: crypto.randomUUID(),
  });
  if (error) return databaseErrorResponse(error.message, requestId);
  const result = databaseResultSchema.safeParse(data);
  if (!result.success) return errorResponse("CLOSEOUT_INVALID_DATA", "Fechamento temporariamente indisponível", requestId, 503);
  const value = result.data;
  const response = sellerCloseoutResponseSchema.parse({ data: {
    closeoutId: value.closeout_id, sellerId: value.seller_id, locationId: value.location_id, status: value.status,
    periodStart: value.period_start, periodEnd: value.period_end,
    confirmedSalesCount: value.confirmed_sales_count, confirmedSalesTotalCents: value.confirmed_sales_total_cents,
    paymentCount: value.payment_count, paymentTotalCents: value.payment_total_cents,
    paymentDifferenceCents: value.payment_difference_cents, stockDifferenceUnits: value.stock_difference_units,
    justification: value.justification,
    paymentSummaries: value.payment_summaries.map((item) => ({ integrationChannel: item.integration_channel, paymentCount: item.payment_count, totalCents: item.total_cents })),
    stockCounts: value.stock_counts.map((item) => ({ productId: item.product_id, expectedQuantity: item.expected_quantity, countedQuantity: item.counted_quantity, differenceQuantity: item.difference_quantity })),
    correlationId: value.correlation_id,
  }, request_id: requestId });
  return NextResponse.json(response, { status: 201, headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
}
