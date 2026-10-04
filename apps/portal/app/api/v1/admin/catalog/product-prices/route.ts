import { createApiError, idempotencyKeySchema, setCatalogProductPriceResponseSchema, setCatalogProductPriceSchema } from "@germinatura/contracts";
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
    await requirePermission("catalog.manage");
    const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    const parsed = setCatalogProductPriceSchema.safeParse(await request.json().catch(() => null));
    if (!key.success || !parsed.success) return fail("INVALID_CATALOG_PRODUCT_PRICE", "Confira o valor, a revisão e o motivo da alteração.", 422);
    const value = parsed.data;
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("set_catalog_product_price", {
      p_product_id: value.productId, p_expected_product_revision: value.expectedProductRevision,
      p_amount_cents: value.amountCents, p_reason: value.reason, p_idempotency_key: key.data,
      p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      if (error.code === "42501") return fail("FORBIDDEN", "Permissão insuficiente.", 403);
      if (error.message === "PRODUCT_NOT_FOUND") return fail("PRODUCT_NOT_FOUND", "Produto não encontrado.", 404);
      if (error.message === "PRODUCT_PRICE_UNCHANGED") return fail(error.message, "O preço informado já está vigente.", 422);
      if (error.message === "PRODUCT_REVISION_CONFLICT" || error.message === "IDEMPOTENCY_CONFLICT" || error.message === "IDEMPOTENCY_IN_PROGRESS") return fail(error.message, "O produto foi alterado em outra sessão ou esta solicitação já está em processamento. Atualize a página antes de tentar novamente.", 409);
      if (error.code === "22023" || error.code === "23514") return fail("INVALID_CATALOG_PRODUCT_PRICE", "Confira o valor, a revisão e o motivo da alteração.", 422);
      return fail("CATALOG_UNAVAILABLE", "Não foi possível definir o preço. Tente novamente.", 503);
    }
    const result = setCatalogProductPriceResponseSchema.safeParse({ data, request_id: requestId });
    if (!result.success) return fail("CATALOG_UNAVAILABLE", "Não foi possível confirmar o preço definido. Tente novamente.", 503);
    return NextResponse.json(result.data, { status: 200, headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("CATALOG_UNAVAILABLE", "Não foi possível definir o preço. Tente novamente.", 503);
  }
}
