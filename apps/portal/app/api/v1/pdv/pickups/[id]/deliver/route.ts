import { deliverPaidPickupResponseSchema, idempotencyKeySchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { reservationErrorResponse } from "@/lib/admin-reservations";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

interface RouteContext { params: Promise<{ id: string }>; }

const databaseResultSchema = z.object({
  reservation_id: z.uuid(), status: z.literal("COMPLETED"), sale_id: z.uuid(), total_cents: z.number().int(),
  paid_online: z.literal(true), correlation_id: z.uuid(),
});

const conflicts: Record<string, string> = {
  COMMERCIAL_RESERVATION_ALREADY_DELIVERED: "Este pedido já foi entregue.",
  COMMERCIAL_RESERVATION_PAYMENT_PENDING: "O pagamento online ainda não foi confirmado pelo PicPay.",
  COMMERCIAL_RESERVATION_NOT_PAID: "Este pedido não está pago; use a retirada com cobrança.",
  IDEMPOTENCY_CONFLICT: "A chave já foi usada com outro conteúdo.",
  IDEMPOTENCY_IN_PROGRESS: "A entrega já está em processamento.",
};

/** RES-005: hands over an order paid online; nothing is charged, moved or posted again. */
export async function POST(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!z.uuid().safeParse(id).success || !key.success) {
    return reservationErrorResponse("INVALID_DELIVERY", "Pedido inválido.", requestId, 422);
  }
  try {
    await requirePermission("sales.create");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("deliver_paid_reservation", {
      p_reservation_id: id, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      const code = Object.keys(conflicts).find((candidate) => error.message.includes(candidate));
      if (code) return reservationErrorResponse(code, conflicts[code], requestId, 409);
      if (error.message.includes("NOT_FOUND")) return reservationErrorResponse("NOT_FOUND", "Pedido não encontrado.", requestId, 404);
      if (error.message.includes("SELLER_REQUIRED")) return reservationErrorResponse("FORBIDDEN", "Operação não autorizada.", requestId, 403);
      return reservationErrorResponse("PICKUP_UNAVAILABLE", "Entrega temporariamente indisponível.", requestId, 503);
    }
    const result = databaseResultSchema.safeParse(data);
    if (!result.success) return reservationErrorResponse("PICKUP_UNAVAILABLE", "Entrega temporariamente indisponível.", requestId, 503);
    return NextResponse.json(deliverPaidPickupResponseSchema.parse({
      data: {
        reservationId: result.data.reservation_id, status: result.data.status, saleId: result.data.sale_id,
        totalCents: result.data.total_cents, paidOnline: result.data.paid_online, correlationId: result.data.correlation_id,
      },
      request_id: requestId,
    }), { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return reservationErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return reservationErrorResponse("PICKUP_UNAVAILABLE", "Entrega temporariamente indisponível.", requestId, 503);
  }
}
