import {
  createApiError, idempotencyKeySchema, resolveSellerStockTransferSchema,
  sellerStockTransferMutationResponseSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const fail = (code: string, message: string, status: number) => NextResponse.json(
    createApiError(code, message, requestId), { status, headers },
  );
  try {
    await requirePermission("inventory.transfer.own");
    const { id } = await context.params;
    const requestIdParsed = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    const parsed = resolveSellerStockTransferSchema.safeParse(await request.json().catch(() => null));
    if (!zUuid(id) || !requestIdParsed.success || !parsed.success) return fail("INVALID_SELLER_TRANSFER", "Confira solicitação, ação e motivo.", 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const correlationId = crypto.randomUUID();
    const { data, error } = await client.rpc("resolve_seller_stock_transfer", {
      p_request_id: id, p_action: parsed.data.action, p_reason: parsed.data.reason,
      p_idempotency_key: requestIdParsed.data, p_correlation_id: correlationId,
    });
    if (error) {
      if (error.code === "42501") return fail("FORBIDDEN", "Você não pode decidir esta solicitação.", 403);
      if (error.message === "TRANSFER_REQUEST_NOT_FOUND") return fail(error.message, "Solicitação não encontrada.", 404);
      if (error.message === "STOCK_CONFLICT" || error.message === "TRANSFER_REQUEST_ALREADY_RESOLVED") return fail(error.message, "O estoque mudou ou a solicitação já foi resolvida.", 409);
      if (["IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_IN_PROGRESS"].includes(error.message)) return fail(error.message, "Esta ação já foi usada ou ainda está em processamento.", 409);
      if (error.code === "22023") return fail("INVALID_SELLER_TRANSFER", "Confira solicitação, ação e motivo.", 422);
      return fail("INVENTORY_UNAVAILABLE", "Não foi possível decidir a transferência.", 503);
    }
    const result = sellerStockTransferMutationResponseSchema.safeParse({
      data: {
        requestId: data?.request_id, status: data?.status,
        movementId: data?.movement_id ?? null, correlationId: data?.correlation_id,
      }, request_id: requestId,
    });
    if (!result.success) return fail("INVENTORY_UNAVAILABLE", "Não foi possível confirmar a decisão.", 503);
    return NextResponse.json(result.data, { headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("INVENTORY_UNAVAILABLE", "Não foi possível decidir a transferência.", 503);
  }
}

function zUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
