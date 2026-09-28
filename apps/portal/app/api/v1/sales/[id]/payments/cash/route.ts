import { cashPaymentRequestSchema, cashPaymentResponseSchema, idempotencyKeySchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { shiftDatabaseError, shiftErrorResponse } from "@/lib/seller-shift";

interface RouteContext { params: Promise<{ id: string }>; }

const databaseResultSchema = z.object({
  sale_id: z.uuid(),
  sale_status: z.literal("CONFIRMED"),
  payment_attempt: z.object({
    attempt_id: z.uuid(), status: z.literal("APPROVED"), amount_cents: z.number().int().nonnegative(),
    integration_channel: z.literal("DINHEIRO"), confirmation_source: z.literal("MANUAL"), confirmed_at: z.string(),
  }),
  cash: z.object({ shift_id: z.uuid(), tendered_cents: z.number().int().nonnegative(), change_cents: z.number().int().nonnegative() }),
  financial_ledger_entry_id: z.uuid(),
  correlation_id: z.uuid(),
});

/** PAY-009: confirms a PDV sale paid in cash within the seller open shift. */
export async function POST(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = cashPaymentRequestSchema.safeParse(await request.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !key.success || !parsed.success) {
    return shiftErrorResponse("INVALID_CASH_PAYMENT", "Informe o valor recebido em centavos.", requestId, 422);
  }
  try {
    await requirePermission("sales.create");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("confirm_cash_payment", {
      p_sale_id: id, p_tendered_cents: parsed.data.tenderedCents,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return shiftDatabaseError(error.message, requestId);
    const result = databaseResultSchema.safeParse(data);
    if (!result.success) return shiftErrorResponse("CASH_PAYMENT_INVALID_DATA", "Recebimento temporariamente indisponível.", requestId, 503);
    const value = result.data;
    return NextResponse.json(cashPaymentResponseSchema.parse({
      data: {
        saleId: value.sale_id, saleStatus: value.sale_status,
        paymentAttempt: {
          attemptId: value.payment_attempt.attempt_id, status: value.payment_attempt.status,
          amountCents: value.payment_attempt.amount_cents, integrationChannel: value.payment_attempt.integration_channel,
          confirmationSource: value.payment_attempt.confirmation_source, confirmedAt: value.payment_attempt.confirmed_at,
        },
        cash: { shiftId: value.cash.shift_id, tenderedCents: value.cash.tendered_cents, changeCents: value.cash.change_cents },
        financialLedgerEntryId: value.financial_ledger_entry_id, correlationId: value.correlation_id,
      },
      request_id: requestId,
    }), { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return shiftErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return shiftErrorResponse("CASH_PAYMENT_UNAVAILABLE", "Recebimento temporariamente indisponível.", requestId, 503);
  }
}
