import {
  confirmedSaleReversalRequestSchema,
  createApiError,
  idempotencyKeySchema,
  salesCancelResponseSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission, requireSession } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

interface RouteContext { params: Promise<{ id: string }>; }

const cancelDatabaseResultSchema = z.object({
  sale_id: z.uuid(),
  status: z.literal("CANCELLED"),
  reservation: z.object({
    reservation_id: z.uuid(),
    status: z.enum(["RELEASED", "EXPIRED"]),
    release_movement_id: z.uuid().nullable(),
  }),
  payment_attempt: z.object({
    attempt_id: z.uuid(),
    status: z.literal("CANCELLED"),
  }),
  correlation_id: z.uuid(),
});

const reversalDatabaseResultSchema = z.object({
  sale_id: z.uuid(),
  status: z.literal("CANCELLED"),
  payment_attempt: z.object({
    attempt_id: z.uuid(),
    status: z.literal("REFUNDED"),
  }),
  reversal: z.object({
    stock_movement_id: z.uuid(),
    refund_entry_id: z.uuid(),
    amount_cents: z.number().int().nonnegative(),
    refund_reference: z.string().min(4).max(128),
  }),
  correlation_id: z.uuid(),
});

function errorResponse(code: string, message: string, requestId: string, status: number) {
  return NextResponse.json(createApiError(code, message, requestId), {
    status,
    headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}

function databaseErrorResponse(message: string, requestId: string) {
  if (message.includes("SALE_NOT_FOUND")) {
    return errorResponse("SALE_NOT_FOUND", "Venda não encontrada", requestId, 404);
  }
  if (message.includes("CONFIRMED_SALE_REVERSAL_REQUIRED")) {
    return errorResponse("CONFIRMED_SALE_REVERSAL_REQUIRED", "Venda confirmada exige reversão auditada", requestId, 409);
  }
  if (message.includes("SALE_NOT_CONFIRMED") || message.includes("SALE_NOT_REVERSIBLE")) {
    return errorResponse("SALE_NOT_REVERSIBLE", "A venda não pode ser revertida neste estado", requestId, 409);
  }
  if (message.includes("PAID_RAFFLE_REVERSAL_REQUIRED")) {
    return errorResponse("PAID_RAFFLE_REVERSAL_REQUIRED", "Venda de rifa paga exige reversão específica", requestId, 409);
  }
  if (message.includes("STOCK_REVERSAL_CONFLICT") || message.includes("SALE_MOVEMENT_ALREADY_REVERSED")) {
    return errorResponse("STOCK_REVERSAL_CONFLICT", "O estoque mudou e a reversão não pôde ser concluída", requestId, 409);
  }
  if (message.includes("IDEMPOTENCY_CONFLICT")) {
    return errorResponse("IDEMPOTENCY_CONFLICT", "A chave já foi usada com outro conteúdo", requestId, 409);
  }
  if (message.includes("IDEMPOTENCY_IN_PROGRESS")) {
    return errorResponse("IDEMPOTENCY_IN_PROGRESS", "O cancelamento já está em processamento", requestId, 409);
  }
  return errorResponse("CANCEL_UNAVAILABLE", "Cancelamento temporariamente indisponível", requestId, 503);
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

  const rawBody: unknown = await request.json().catch(() => ({}));
  const hasReversalPayload = typeof rawBody === "object" && rawBody !== null && Object.keys(rawBody).length > 0;
  const reversalRequest = hasReversalPayload ? confirmedSaleReversalRequestSchema.safeParse(rawBody) : null;
  if (reversalRequest && !reversalRequest.success) {
    return errorResponse("INVALID_CONFIRMED_SALE_REVERSAL", "Informe motivo e referência não sensível do estorno", requestId, 422);
  }

  try {
    if (reversalRequest?.success) await requirePermission("finance.manage");
    else await requireSession();
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return errorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    }
    return errorResponse("CANCEL_UNAVAILABLE", "Cancelamento temporariamente indisponível", requestId, 503);
  }

  let supabase: SupabaseClient;
  try {
    supabase = await createAuthenticatedSupabaseClient(request);
  } catch {
    return errorResponse("CANCEL_UNAVAILABLE", "Cancelamento temporariamente indisponível", requestId, 503);
  }
  const correlationId = crypto.randomUUID();
  const { data, error } = reversalRequest?.success
    ? await supabase.rpc("reverse_confirmed_sale", {
        p_sale_id: id,
        p_reason: reversalRequest.data.reason,
        p_refund_reference: reversalRequest.data.refundReference,
        p_idempotency_key: idempotency.data,
        p_correlation_id: correlationId,
      })
    : await supabase.rpc("cancel_sale", {
        p_sale_id: id,
        p_idempotency_key: idempotency.data,
        p_correlation_id: correlationId,
      });
  if (error) return databaseErrorResponse(error.message, requestId);

  if (reversalRequest?.success) {
    const parsed = reversalDatabaseResultSchema.safeParse(data);
    if (!parsed.success) {
      return errorResponse("CANCEL_INVALID_DATA", "Reversão temporariamente indisponível", requestId, 503);
    }
    const value = parsed.data;
    return NextResponse.json(salesCancelResponseSchema.parse({
      data: {
        saleId: value.sale_id,
        status: value.status,
        paymentAttempt: {
          attemptId: value.payment_attempt.attempt_id,
          status: value.payment_attempt.status,
        },
        reversal: {
          stockMovementId: value.reversal.stock_movement_id,
          refundEntryId: value.reversal.refund_entry_id,
          amountCents: value.reversal.amount_cents,
          refundReference: value.reversal.refund_reference,
        },
        correlationId: value.correlation_id,
      },
      request_id: requestId,
    }), { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  }

  const parsed = cancelDatabaseResultSchema.safeParse(data);
  if (!parsed.success) {
    return errorResponse("CANCEL_INVALID_DATA", "Cancelamento temporariamente indisponível", requestId, 503);
  }
  const value = parsed.data;
  const response = salesCancelResponseSchema.parse({
    data: {
      saleId: value.sale_id,
      status: value.status,
      reservation: {
        reservationId: value.reservation.reservation_id,
        status: value.reservation.status,
        releaseMovementId: value.reservation.release_movement_id,
      },
      paymentAttempt: {
        attemptId: value.payment_attempt.attempt_id,
        status: value.payment_attempt.status,
      },
      correlationId: value.correlation_id,
    },
    request_id: requestId,
  });
  return NextResponse.json(response, {
    headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}
