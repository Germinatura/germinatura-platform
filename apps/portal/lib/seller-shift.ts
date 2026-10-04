import { adminSellerShiftSchema, createApiError, sellerShiftSchema } from "@germinatura/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

// Summary returned by private.seller_shift_summary.
export const databaseShiftSchema = z.object({
  shift_id: z.uuid(),
  status: z.enum(["OPEN", "CLOSED"]),
  location_id: z.uuid(),
  opened_at: z.string(),
  closed_at: z.string().nullable(),
  opening_cash_cents: z.number().int().nonnegative(),
  cash_sales_count: z.number().int().nonnegative(),
  cash_sales_total_cents: z.number().int().nonnegative(),
  cash_refunds_count: z.number().int().nonnegative(),
  cash_refunds_total_cents: z.number().int().nonnegative(),
  expected_cash_cents: z.number().int().nonnegative(),
  counted_cash_cents: z.number().int().nonnegative().nullable(),
  difference_cents: z.number().int().nullable(),
  justification: z.string().nullable(),
});

export function toSellerShift(value: z.infer<typeof databaseShiftSchema>) {
  return sellerShiftSchema.parse({
    shiftId: value.shift_id, status: value.status, locationId: value.location_id,
    openedAt: value.opened_at, closedAt: value.closed_at, openingCashCents: value.opening_cash_cents,
    cashSalesCount: value.cash_sales_count, cashSalesTotalCents: value.cash_sales_total_cents,
    cashRefundsCount: value.cash_refunds_count, cashRefundsTotalCents: value.cash_refunds_total_cents,
    expectedCashCents: value.expected_cash_cents, countedCashCents: value.counted_cash_cents,
    differenceCents: value.difference_cents, justification: value.justification,
  });
}

// Finance review rows returned by public.list_seller_shifts.
export const databaseAdminShiftSchema = databaseShiftSchema.extend({
  seller_id: z.uuid(),
  seller_name: z.string(),
  location_name: z.string(),
});

export function toAdminSellerShift(value: z.infer<typeof databaseAdminShiftSchema>) {
  return adminSellerShiftSchema.parse({
    ...toSellerShift(value), sellerId: value.seller_id, sellerName: value.seller_name, locationName: value.location_name,
  });
}

export function shiftErrorResponse(code: string, message: string, requestId: string, status: number) {
  return NextResponse.json(createApiError(code, message, requestId), {
    status, headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}

/** Maps database errors of the shift and cash commands to API responses. */
export function shiftDatabaseError(message: string, requestId: string) {
  const conflicts: Record<string, string> = {
    SELLER_SHIFT_ALREADY_OPEN: "Você já tem um turno aberto.",
    SELLER_SHIFT_NOT_OPEN: "Este turno já foi fechado.",
    SELLER_SHIFT_REQUIRED: "Abra um turno antes de receber em dinheiro.",
    SELLER_SHIFT_LOCATION_MISMATCH: "A venda é de outro local de estoque.",
    SELLER_SHIFT_JUSTIFICATION_REQUIRED: "Explique a diferença entre o contado e o esperado.",
    CASH_TENDERED_INSUFFICIENT: "O valor recebido não cobre o total da venda.",
    SALE_NOT_AWAITING_PAYMENT: "A venda não pode mais ser confirmada.",
    PAYMENT_ATTEMPT_NOT_CONFIRMABLE: "A venda não pode mais ser confirmada.",
    SALE_RESERVATION_NOT_ACTIVE: "A reserva da venda expirou.",
    SALE_RESERVATION_EXPIRED: "A reserva da venda expirou.",
    IDEMPOTENCY_CONFLICT: "A chave já foi usada com outro conteúdo.",
    IDEMPOTENCY_IN_PROGRESS: "A operação já está em processamento.",
    FEATURE_DISABLED: "Recebimento em dinheiro desativado.",
  };
  const code = Object.keys(conflicts).find((key) => message.includes(key));
  if (code) return shiftErrorResponse(code, conflicts[code], requestId, 409);
  if (message.includes("SELLER_SHIFT_NOT_FOUND") || message.includes("SALE_NOT_FOUND") || message.includes("PAYMENT_ATTEMPT_NOT_FOUND")) {
    return shiftErrorResponse("NOT_FOUND", "Registro não encontrado.", requestId, 404);
  }
  if (message.includes("FORBIDDEN") || message.includes("SELLER_REQUIRED")) {
    return shiftErrorResponse("FORBIDDEN", "Operação não autorizada.", requestId, 403);
  }
  if (message.includes("INVALID_")) return shiftErrorResponse("INVALID_REQUEST", "Confira os valores informados.", requestId, 422);
  return shiftErrorResponse("SHIFT_UNAVAILABLE", "Operação de caixa temporariamente indisponível.", requestId, 503);
}
