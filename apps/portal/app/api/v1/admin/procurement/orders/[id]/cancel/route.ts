import { cancelPurchaseOrderSchema, createApiError, idempotencyKeySchema, purchaseOrderCommandResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const fail = (code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers });
  try {
    await requirePermission("procurement.manage");
    const orderId = z.uuid().safeParse((await params).id);
    const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    const body = cancelPurchaseOrderSchema.safeParse(await request.json().catch(() => null));
    if (!orderId.success || !key.success || !body.success) return fail("INVALID_PURCHASE_ORDER", "Pedido ou motivo inválido.", 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("cancel_purchase_order", {
      p_order_id: orderId.data, p_reason: body.data.reason, p_idempotency_key: key.data,
      p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      if (error.code === "42501") return fail("FORBIDDEN", "Permissão insuficiente.", 403);
      if (error.message === "PURCHASE_ORDER_NOT_FOUND") return fail(error.message, "Pedido não encontrado.", 404);
      if (["PURCHASE_ORDER_NOT_OPEN", "IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_IN_PROGRESS"].includes(error.message)) return fail(error.message, "Pedido alterado ou solicitação já processada.", 409);
      if (error.code === "22023") return fail("INVALID_PURCHASE_ORDER", "Motivo inválido.", 422);
      return fail("PROCUREMENT_UNAVAILABLE", "Não foi possível cancelar o pedido.", 503);
    }
    const result = purchaseOrderCommandResponseSchema.safeParse({ data, request_id: requestId });
    if (!result.success) return fail("PROCUREMENT_UNAVAILABLE", "Não foi possível confirmar o cancelamento.", 503);
    return NextResponse.json(result.data, { headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("PROCUREMENT_UNAVAILABLE", "Não foi possível cancelar o pedido.", 503);
  }
}
