import { completePickupRequestSchema, completePickupResponseSchema, idempotencyKeySchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { reservationErrorResponse } from "@/lib/admin-reservations";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

interface RouteContext { params: Promise<{ id: string }>; }

const databaseResultSchema = z.object({
  reservation_id: z.uuid(), status: z.literal("COMPLETED"), sale_id: z.uuid(), total_cents: z.number().int(),
  integration_channel: z.enum(["DINHEIRO", "MAQUININHA", "PIX_AREA"]), change_cents: z.number().int().nullable(),
  card_method: z.string().nullable(), correlation_id: z.uuid(),
});

const conflicts: Record<string, string> = {
  COMMERCIAL_RESERVATION_NOT_READY: "A reserva ainda não foi separada ou já foi retirada.",
  COMMERCIAL_RESERVATION_EXPIRED: "O prazo de retirada terminou.",
  SELLER_SHIFT_REQUIRED: "Abra um turno neste local antes de receber em dinheiro.",
  SELLER_SHIFT_LOCATION_MISMATCH: "Seu turno está aberto em outro local.",
  CASH_TENDERED_INSUFFICIENT: "O valor recebido não cobre o total da reserva.",
  PAYMENT_TERMINAL_REQUIRED: "Informe qual maquininha foi usada.",
  PAYMENT_TERMINAL_UNAVAILABLE: "Maquininha inativa ou não cadastrada.",
  PROOF_REFERENCE_ALREADY_USED: "Referência já utilizada.",
  FEATURE_DISABLED: "Este meio de pagamento ainda não está habilitado.",
  IDEMPOTENCY_CONFLICT: "A chave já foi usada com outro conteúdo.",
  IDEMPOTENCY_IN_PROGRESS: "A retirada já está em processamento.",
};

/** RES-003: hands over a prepared reservation, charging the frozen price in one atomic step. */
export async function POST(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = completePickupRequestSchema.safeParse(await request.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !key.success || !parsed.success) {
    return reservationErrorResponse("INVALID_PICKUP", "Confira a forma de pagamento da retirada.", requestId, 422);
  }
  try {
    await requirePermission("sales.create");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("complete_reservation_pickup", {
      p_reservation_id: id, p_integration_channel: parsed.data.integrationChannel, p_tendered_cents: parsed.data.tenderedCents,
      p_proof_reference: parsed.data.proofReference, p_card_method: parsed.data.cardMethod, p_terminal_id: parsed.data.terminalId,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      const code = Object.keys(conflicts).find((candidate) => error.message.includes(candidate));
      if (code) return reservationErrorResponse(code, conflicts[code], requestId, 409);
      if (error.message.includes("NOT_FOUND")) return reservationErrorResponse("NOT_FOUND", "Reserva não encontrada.", requestId, 404);
      if (error.message.includes("SELLER_REQUIRED")) return reservationErrorResponse("FORBIDDEN", "Operação não autorizada.", requestId, 403);
      if (error.message.includes("INVALID_") || error.message.includes("CARD_")) return reservationErrorResponse("INVALID_PICKUP", "Confira a forma de pagamento da retirada.", requestId, 422);
      return reservationErrorResponse("PICKUP_UNAVAILABLE", "Retirada temporariamente indisponível.", requestId, 503);
    }
    const result = databaseResultSchema.safeParse(data);
    if (!result.success) return reservationErrorResponse("PICKUP_UNAVAILABLE", "Retirada temporariamente indisponível.", requestId, 503);
    return NextResponse.json(completePickupResponseSchema.parse({
      data: {
        reservationId: result.data.reservation_id, status: result.data.status, saleId: result.data.sale_id,
        totalCents: result.data.total_cents, integrationChannel: result.data.integration_channel,
        changeCents: result.data.change_cents, cardMethod: result.data.card_method, correlationId: result.data.correlation_id,
      },
      request_id: requestId,
    }), { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return reservationErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return reservationErrorResponse("PICKUP_UNAVAILABLE", "Retirada temporariamente indisponível.", requestId, 503);
  }
}
