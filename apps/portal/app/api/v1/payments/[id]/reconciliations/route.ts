import {
  createApiError,
  idempotencyKeySchema,
  paymentReconciliationRequestSchema,
  paymentReconciliationResponseSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

interface RouteContext { params: Promise<{ id: string }>; }

const databaseResultSchema = z.object({
  reconciliation_id: z.uuid(),
  attempt_id: z.uuid(),
  payment_status: z.enum(["RECONCILIATION_PENDING", "RECONCILED"]),
  outcome: z.enum(["DIVERGENT", "MATCHED"]),
  expected_amount_cents: z.number().int().nonnegative(),
  observed_amount_cents: z.number().int().positive(),
  fee_amount_cents: z.number().int().nonnegative(),
  net_amount_cents: z.number().int().positive(),
  source: z.literal("MANUAL"),
  external_reference: z.string(),
  ledger: z.object({
    fee_entry_id: z.uuid().nullable(),
    settlement_entry_id: z.uuid().nullable(),
    divergence_entry_id: z.uuid().nullable(),
  }),
  correlation_id: z.uuid(),
});

function errorResponse(code: string, message: string, requestId: string, status: number, details?: unknown) {
  return NextResponse.json(createApiError(code, message, requestId, details), {
    status,
    headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}

function databaseErrorResponse(message: string, requestId: string) {
  if (message.includes("PAYMENT_ATTEMPT_NOT_FOUND")) {
    return errorResponse("PAYMENT_ATTEMPT_NOT_FOUND", "Tentativa de pagamento não encontrada", requestId, 404);
  }
  if (message.includes("RECONCILIATION_REFERENCE_ALREADY_USED")) {
    return errorResponse("RECONCILIATION_REFERENCE_ALREADY_USED", "Referência já conciliada", requestId, 409);
  }
  if (message.includes("IDEMPOTENCY_CONFLICT")) {
    return errorResponse("IDEMPOTENCY_CONFLICT", "A chave já foi usada com outro conteúdo", requestId, 409);
  }
  if (message.includes("IDEMPOTENCY_IN_PROGRESS")) {
    return errorResponse("IDEMPOTENCY_IN_PROGRESS", "A conciliação já está em processamento", requestId, 409);
  }
  if (message.includes("PAYMENT_ATTEMPT_NOT_RECONCILABLE")) {
    return errorResponse("PAYMENT_ATTEMPT_NOT_RECONCILABLE", "O pagamento não pode ser conciliado neste estado", requestId, 409);
  }
  return errorResponse("RECONCILIATION_UNAVAILABLE", "Conciliação temporariamente indisponível", requestId, 503);
}

export async function POST(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const idempotency = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!idempotency.success) {
    return errorResponse("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key inválida ou ausente", requestId, 422);
  }
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) {
    return errorResponse("INVALID_PAYMENT_ATTEMPT", "Tentativa de pagamento inválida", requestId, 422);
  }
  const body = await request.json().catch(() => null);
  const parsed = paymentReconciliationRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_RECONCILIATION", "Valores ou referência inválidos", requestId, 422, parsed.error.issues);
  }

  try {
    await requirePermission("finance.manage");
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return errorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    }
    return errorResponse("RECONCILIATION_UNAVAILABLE", "Conciliação temporariamente indisponível", requestId, 503);
  }

  let supabase;
  try {
    supabase = await createAuthenticatedSupabaseClient(request);
  } catch {
    return errorResponse("RECONCILIATION_UNAVAILABLE", "Conciliação temporariamente indisponível", requestId, 503);
  }
  const { data, error } = await supabase.rpc("reconcile_payment_attempt", {
    p_attempt_id: id,
    p_observed_amount_cents: parsed.data.observedAmountCents,
    p_fee_amount_cents: parsed.data.feeAmountCents,
    p_external_reference: parsed.data.externalReference,
    p_source: "MANUAL",
    p_idempotency_key: idempotency.data,
    p_correlation_id: crypto.randomUUID(),
  });
  if (error) return databaseErrorResponse(error.message, requestId);

  const result = databaseResultSchema.safeParse(data);
  if (!result.success) {
    return errorResponse("RECONCILIATION_INVALID_DATA", "Conciliação temporariamente indisponível", requestId, 503);
  }
  const value = result.data;
  const response = paymentReconciliationResponseSchema.parse({
    data: {
      reconciliationId: value.reconciliation_id,
      attemptId: value.attempt_id,
      paymentStatus: value.payment_status,
      outcome: value.outcome,
      expectedAmountCents: value.expected_amount_cents,
      observedAmountCents: value.observed_amount_cents,
      feeAmountCents: value.fee_amount_cents,
      netAmountCents: value.net_amount_cents,
      source: value.source,
      externalReference: value.external_reference,
      ledger: {
        feeEntryId: value.ledger.fee_entry_id,
        settlementEntryId: value.ledger.settlement_entry_id,
        divergenceEntryId: value.ledger.divergence_entry_id,
      },
      correlationId: value.correlation_id,
    },
    request_id: requestId,
  });
  return NextResponse.json(response, {
    headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}
