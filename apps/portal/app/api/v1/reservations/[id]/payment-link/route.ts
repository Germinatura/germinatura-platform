import { createApiError, idempotencyKeySchema, paymentLinkChargeResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requireSession } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { paymentLinkChargeFromRow } from "@/lib/payment-links";

interface RouteContext { params: Promise<{ id: string }>; }

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });
const fail = (code: string, message: string, requestId: string, status: number) =>
  NextResponse.json(createApiError(code, message, requestId), { status, headers: headers(requestId) });

/** ADR 0010: the consumer pays an active reservation online; PicPay sends them back to the Portal's tracking page. */
export async function POST(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const reservationId = z.uuid().safeParse((await context.params).id);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!reservationId.success) return fail("RESERVATION_NOT_FOUND", "Reserva não encontrada", requestId, 404);
  if (!key.success) return fail("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key inválida ou ausente", requestId, 422);
  // The return address comes from configuration, never from request headers.
  const returnBase = new URL(process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://127.0.0.1:3000").origin;
  try {
    await requireSession();
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("request_portal_payment_link", {
      p_reservation_id: reservationId.data, p_return_base_url: returnBase, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      if (error.message.includes("FEATURE_DISABLED")) return fail("FEATURE_DISABLED", "O pagamento online ainda não está disponível", requestId, 409);
      if (error.message.includes("COMMERCIAL_RESERVATION_NOT_FOUND")) return fail("RESERVATION_NOT_FOUND", "Reserva não encontrada", requestId, 404);
      if (error.message.includes("NOT_PAYABLE") || error.message.includes("SALE_NOT_AWAITING_PAYMENT") || error.message.includes("PAYMENT_ATTEMPT_NOT_CONFIRMABLE")) {
        return fail("RESERVATION_NOT_PAYABLE", "Esta reserva não pode mais ser paga online", requestId, 409);
      }
      if (error.message.includes("IDEMPOTENCY_CONFLICT")) return fail("IDEMPOTENCY_CONFLICT", "A chave já foi usada com outro conteúdo", requestId, 409);
      if (error.message.includes("IDEMPOTENCY_IN_PROGRESS")) return fail("IDEMPOTENCY_IN_PROGRESS", "O pedido já está em processamento", requestId, 409);
      return fail("PAYMENT_LINK_UNAVAILABLE", "Pagamento online temporariamente indisponível", requestId, 503);
    }
    const charge = paymentLinkChargeFromRow(data);
    if (!charge) return fail("PAYMENT_LINK_UNAVAILABLE", "Pagamento online temporariamente indisponível", requestId, 503);
    return NextResponse.json(paymentLinkChargeResponseSchema.parse({ data: charge, request_id: requestId }), { status: 201, headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return fail("PAYMENT_LINK_UNAVAILABLE", "Pagamento online temporariamente indisponível", requestId, 503);
  }
}
