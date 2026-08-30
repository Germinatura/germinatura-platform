import {
  createApiError,
  idempotencyKeySchema,
  salesCancelResponseSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requireSession } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

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

function errorResponse(code: string, message: string, requestId: string, status: number) {
  return NextResponse.json(createApiError(code, message, requestId), {
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
  if (message.includes("SALE_NOT_FOUND")) {
    return errorResponse("SALE_NOT_FOUND", "Venda não encontrada", requestId, 404);
  }
  if (message.includes("CONFIRMED_SALE_REVERSAL_REQUIRED")) {
    return errorResponse("CONFIRMED_SALE_REVERSAL_REQUIRED", "Venda confirmada exige reversão auditada", requestId, 409);
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

  try {
    await requireSession();
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return errorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    }
    return errorResponse("CANCEL_UNAVAILABLE", "Cancelamento temporariamente indisponível", requestId, 503);
  }

  let supabase: SupabaseClient;
  try {
    supabase = await authenticatedClient(request);
  } catch {
    return errorResponse("CANCEL_UNAVAILABLE", "Cancelamento temporariamente indisponível", requestId, 503);
  }
  const { data, error } = await supabase.rpc("cancel_sale", {
    p_sale_id: id,
    p_idempotency_key: idempotency.data,
    p_correlation_id: crypto.randomUUID(),
  });
  if (error) return databaseErrorResponse(error.message, requestId);

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
