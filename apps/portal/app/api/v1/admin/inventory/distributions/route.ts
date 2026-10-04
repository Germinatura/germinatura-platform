import { createApiError, distributeStockResponseSchema, distributeStockSchema, idempotencyKeySchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const fail = (code: string, message: string, status: number) => NextResponse.json(
    createApiError(code, message, requestId), { status, headers },
  );
  try {
    await requirePermission("inventory.manage");
    const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    const parsed = distributeStockSchema.safeParse(await request.json().catch(() => null));
    if (!key.success || !parsed.success) return fail("INVALID_STOCK_DISTRIBUTION", "Confira produto, origem, destino, quantidade e motivo.", 422);
    const value = parsed.data;
    const correlationId = crypto.randomUUID();
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("distribute_stock", {
      p_from_location_id: value.fromLocationId,
      p_to_location_id: value.toLocationId,
      p_product_id: value.productId,
      p_quantity: value.quantity,
      p_reason: value.reason,
      p_idempotency_key: key.data,
      p_correlation_id: correlationId,
    });
    if (error) {
      if (error.code === "42501") return fail("FORBIDDEN", "Permissão insuficiente.", 403);
      if (error.message === "STOCK_CONFLICT") return fail("STOCK_CONFLICT", "O saldo disponível mudou. Atualize a página e tente novamente.", 409);
      if (["IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_IN_PROGRESS"].includes(error.message)) return fail(error.message, "Esta solicitação já foi usada ou ainda está em processamento.", 409);
      if (error.message === "PRODUCT_NOT_FOUND") return fail("PRODUCT_NOT_FOUND", "Produto ativo não encontrado.", 404);
      if (error.message === "DISTRIBUTION_SOURCE_MUST_BE_CENTRAL" || error.message === "DISTRIBUTION_DESTINATION_MUST_BE_SELLER" || error.code === "22023") return fail("INVALID_STOCK_DISTRIBUTION", "A distribuição deve sair da central ativa e chegar a um vendedor ativo.", 422);
      return fail("INVENTORY_UNAVAILABLE", "Não foi possível distribuir o estoque. Tente novamente.", 503);
    }
    const result = distributeStockResponseSchema.safeParse({
      data: {
        movementId: data?.movement_id,
        fromLocationId: data?.from_location_id,
        toLocationId: data?.to_location_id,
        productId: data?.product_id,
        quantity: data?.quantity,
        fromOnHandQuantity: data?.from_on_hand_quantity,
        toOnHandQuantity: data?.to_on_hand_quantity,
        correlationId: data?.correlation_id,
      },
      request_id: requestId,
    });
    if (!result.success) return fail("INVENTORY_UNAVAILABLE", "Não foi possível confirmar a distribuição. Atualize a página.", 503);
    return NextResponse.json(result.data, { status: 201, headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("INVENTORY_UNAVAILABLE", "Não foi possível distribuir o estoque. Tente novamente.", 503);
  }
}
