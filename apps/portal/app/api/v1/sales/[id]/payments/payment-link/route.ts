import { createApiError, idempotencyKeySchema, paymentLinkChargeResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { paymentLinkChargeFromRow } from "@/lib/payment-links";

interface RouteContext { params: Promise<{ id: string }>; }

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });
const fail = (code: string, message: string, requestId: string, status: number) =>
  NextResponse.json(createApiError(code, message, requestId), { status, headers: headers(requestId) });

/** ADR 0010: the seller asks for a Payment Link; only the jobs worker talks to PicPay. */
export async function POST(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  const saleId = z.uuid().safeParse(id);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!saleId.success) return fail("SALE_NOT_FOUND", "Venda não encontrada", requestId, 404);
  if (!key.success) return fail("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key inválida ou ausente", requestId, 422);
  try {
    await requirePermission("sales.create");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("request_payment_link", {
      p_sale_id: saleId.data, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      if (error.message.includes("FEATURE_DISABLED")) return fail("FEATURE_DISABLED", "O link de pagamento ainda não está habilitado", requestId, 409);
      if (error.message.includes("SALE_NOT_FOUND")) return fail("SALE_NOT_FOUND", "Venda não encontrada", requestId, 404);
      if (error.message.includes("SALE_NOT_AWAITING_PAYMENT") || error.message.includes("PAYMENT_ATTEMPT_NOT_CONFIRMABLE")) {
        return fail("PAYMENT_LINK_CONFLICT", "A venda não aguarda mais pagamento", requestId, 409);
      }
      if (error.message.includes("PAYMENT_AMOUNT_MISMATCH")) return fail("PAYMENT_LINK_CONFLICT", "O valor da venda mudou; refaça a cobrança", requestId, 409);
      if (error.message.includes("IDEMPOTENCY_CONFLICT")) return fail("IDEMPOTENCY_CONFLICT", "A chave já foi usada com outro conteúdo", requestId, 409);
      if (error.message.includes("IDEMPOTENCY_IN_PROGRESS")) return fail("IDEMPOTENCY_IN_PROGRESS", "O pedido já está em processamento", requestId, 409);
      if (error.message.includes("SELLER_REQUIRED")) return fail("FORBIDDEN", "Somente vendedores pedem links de pagamento", requestId, 403);
      return fail("PAYMENT_LINK_UNAVAILABLE", "Link de pagamento temporariamente indisponível", requestId, 503);
    }
    const charge = paymentLinkChargeFromRow(data);
    if (!charge) return fail("PAYMENT_LINK_UNAVAILABLE", "Link de pagamento temporariamente indisponível", requestId, 503);
    return NextResponse.json(paymentLinkChargeResponseSchema.parse({ data: charge, request_id: requestId }), { status: 201, headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return fail("PAYMENT_LINK_UNAVAILABLE", "Link de pagamento temporariamente indisponível", requestId, 503);
  }
}
