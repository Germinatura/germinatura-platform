import { createApiError, idempotencyKeySchema, paymentLinkChargeResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requireSession } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { paymentLinkChargeFromRow } from "@/lib/payment-links";

/** Spec 4.4 (RAF-003): the buyer pays reserved raffle numbers with a PicPay Payment Link. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const fail = (code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers });
  const saleId = z.uuid().safeParse((await context.params).id);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!saleId.success) return fail("SALE_NOT_FOUND", "Reserva não encontrada", 404);
  if (!key.success) return fail("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key inválida ou ausente", 422);
  // The return address comes from configuration, never from request headers.
  const returnBase = new URL(process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://127.0.0.1:3000").origin;
  try {
    await requireSession();
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("request_customer_payment_link", {
      p_sale_id: saleId.data, p_return_base_url: returnBase, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      if (error.message.includes("FEATURE_DISABLED")) return fail("FEATURE_DISABLED", "O pagamento online ainda não está disponível", 409);
      if (error.message.includes("SALE_NOT_FOUND")) return fail("SALE_NOT_FOUND", "Reserva não encontrada", 404);
      if (error.message.includes("SALE_NOT_AWAITING_PAYMENT") || error.message.includes("PAYMENT_ATTEMPT_NOT_CONFIRMABLE")) {
        return fail("SALE_NOT_PAYABLE", "Esta reserva não aguarda mais pagamento", 409);
      }
      if (error.message.includes("IDEMPOTENCY_")) return fail("IDEMPOTENCY_CONFLICT", "O pedido já está em processamento", 409);
      return fail("PAYMENT_LINK_UNAVAILABLE", "Pagamento online temporariamente indisponível", 503);
    }
    const charge = paymentLinkChargeFromRow(data);
    if (!charge) return fail("PAYMENT_LINK_UNAVAILABLE", "Pagamento online temporariamente indisponível", 503);
    return NextResponse.json(paymentLinkChargeResponseSchema.parse({ data: charge, request_id: requestId }), { status: 201, headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("PAYMENT_LINK_UNAVAILABLE", "Pagamento online temporariamente indisponível", 503);
  }
}
