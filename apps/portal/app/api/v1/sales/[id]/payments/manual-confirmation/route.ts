import {
  createApiError,
  idempotencyKeySchema,
  manualPaymentConfirmationRequestSchema,
  manualPaymentConfirmationResponseSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

interface RouteContext { params: Promise<{ id: string }>; }

const databaseResultSchema = z.object({
  sale_id: z.uuid(),
  sale_status: z.literal("CONFIRMED"),
  payment_attempt: z.object({
    attempt_id: z.uuid(),
    status: z.literal("APPROVED"),
    amount_cents: z.number().int().nonnegative(),
    integration_channel: z.enum(["MAQUININHA", "PIX_AREA"]),
    confirmation_source: z.literal("MANUAL"),
    confirmed_at: z.string(),
    proof_reference: z.string(),
  }),
  stock: z.object({
    reservation_id: z.uuid(),
    status: z.literal("CONSUMED"),
    sale_movement_id: z.uuid(),
  }),
  financial_ledger_entry_id: z.uuid(),
  correlation_id: z.uuid(),
});

function errorResponse(code: string, message: string, requestId: string, status: number, details?: unknown) {
  return NextResponse.json(createApiError(code, message, requestId, details), {
    status,
    headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}

function databaseErrorResponse(message: string, requestId: string) {
  if (message.includes("SALE_NOT_FOUND") || message.includes("PAYMENT_ATTEMPT_NOT_FOUND")) {
    return errorResponse("SALE_NOT_FOUND", "Venda não encontrada", requestId, 404);
  }
  if (message.includes("PROOF_REFERENCE_ALREADY_USED")) {
    return errorResponse("PROOF_REFERENCE_ALREADY_USED", "Referência já utilizada", requestId, 409);
  }
  if (message.includes("IDEMPOTENCY_CONFLICT")) {
    return errorResponse("IDEMPOTENCY_CONFLICT", "A chave já foi usada com outro conteúdo", requestId, 409);
  }
  if (message.includes("IDEMPOTENCY_IN_PROGRESS")) {
    return errorResponse("IDEMPOTENCY_IN_PROGRESS", "A confirmação já está em processamento", requestId, 409);
  }
  if (
    message.includes("SALE_NOT_AWAITING_PAYMENT")
    || message.includes("PAYMENT_ATTEMPT_NOT_CONFIRMABLE")
    || message.includes("SALE_RESERVATION_NOT_ACTIVE")
    || message.includes("SALE_RESERVATION_EXPIRED")
    || message.includes("SALE_STOCK_CONSUMPTION_CONFLICT")
  ) {
    return errorResponse("MANUAL_CONFIRMATION_CONFLICT", "A venda não pode mais ser confirmada", requestId, 409);
  }
  return errorResponse("MANUAL_CONFIRMATION_UNAVAILABLE", "Confirmação temporariamente indisponível", requestId, 503);
}

export async function POST(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const idempotency = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!idempotency.success) {
    return errorResponse("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key inválida ou ausente", requestId, 422);
  }
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) {
    return errorResponse("INVALID_SALE", "Venda inválida", requestId, 422);
  }
  const body = await request.json().catch(() => null);
  const parsed = manualPaymentConfirmationRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      "INVALID_MANUAL_CONFIRMATION",
      "Canal ou referência não sensível inválidos",
      requestId,
      422,
      parsed.error.issues,
    );
  }

  try {
    await requirePermission("sales.create");
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return errorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    }
    return errorResponse("MANUAL_CONFIRMATION_UNAVAILABLE", "Confirmação temporariamente indisponível", requestId, 503);
  }

  let supabase;
  try {
    supabase = await createAuthenticatedSupabaseClient(request);
  } catch {
    return errorResponse("MANUAL_CONFIRMATION_UNAVAILABLE", "Confirmação temporariamente indisponível", requestId, 503);
  }
  const { data, error } = await supabase.rpc("confirm_manual_payment", {
    p_sale_id: id,
    p_integration_channel: parsed.data.integrationChannel,
    p_proof_reference: parsed.data.proofReference,
    p_idempotency_key: idempotency.data,
    p_correlation_id: crypto.randomUUID(),
  });
  if (error) return databaseErrorResponse(error.message, requestId);

  const result = databaseResultSchema.safeParse(data);
  if (!result.success) {
    return errorResponse("MANUAL_CONFIRMATION_INVALID_DATA", "Confirmação temporariamente indisponível", requestId, 503);
  }
  const value = result.data;
  const response = manualPaymentConfirmationResponseSchema.parse({
    data: {
      saleId: value.sale_id,
      saleStatus: value.sale_status,
      paymentAttempt: {
        attemptId: value.payment_attempt.attempt_id,
        status: value.payment_attempt.status,
        amountCents: value.payment_attempt.amount_cents,
        integrationChannel: value.payment_attempt.integration_channel,
        confirmationSource: value.payment_attempt.confirmation_source,
        confirmedAt: value.payment_attempt.confirmed_at,
        proofReference: value.payment_attempt.proof_reference,
      },
      stock: {
        reservationId: value.stock.reservation_id,
        status: value.stock.status,
        saleMovementId: value.stock.sale_movement_id,
      },
      financialLedgerEntryId: value.financial_ledger_entry_id,
      correlationId: value.correlation_id,
    },
    request_id: requestId,
  });
  return NextResponse.json(response, {
    headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}
