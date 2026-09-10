import { createApiError, idempotencyKeySchema, saveCatalogProductResponseSchema, saveCatalogProductSchema } from "@germinatura/contracts";
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
    const parsed = saveCatalogProductSchema.safeParse(await request.json().catch(() => null));
    if (!key.success || !parsed.success) return fail("INVALID_CATALOG_PRODUCT", "Confira os campos e o motivo da alteração.", 422);
    const value = parsed.data;
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("save_catalog_product", {
      p_product_id: value.id, p_expected_revision: value.expectedRevision, p_category_id: value.categoryId,
      p_slug: value.slug, p_name: value.name, p_description: value.description, p_active: value.active,
      p_published: value.published, p_sellable_pdv: value.sellablePdv, p_reservable: value.reservable,
      p_tracks_lots: value.tracksLots, p_reason: value.reason, p_idempotency_key: key.data,
      p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      if (error.code === "42501") return fail("FORBIDDEN", "Permissão insuficiente.", 403);
      if (error.message === "PRODUCT_NOT_FOUND" || error.message === "PRODUCT_CATEGORY_NOT_FOUND") return fail(error.message, "Produto ou categoria não encontrado.", 404);
      if (error.message === "PRODUCT_CATEGORY_INACTIVE") return fail(error.message, "Escolha uma categoria ativa antes de salvar o produto.", 422);
      if (error.message === "PRODUCT_CURRENT_PRICE_REQUIRED") return fail(error.message, "Defina um preço vigente antes de publicar ou disponibilizar no PDV.", 422);
      if (error.message === "PRODUCT_REVISION_CONFLICT" || error.message === "IDEMPOTENCY_CONFLICT" || error.message === "IDEMPOTENCY_IN_PROGRESS") return fail(error.message, "O produto foi alterado em outra sessão ou esta solicitação já está em processamento. Atualize a página antes de editar novamente.", 409);
      if (error.code === "23505") return fail("PRODUCT_SLUG_CONFLICT", "Este identificador já pertence a outro produto.", 409);
      if (error.code === "22023" || error.code === "23514") return fail("INVALID_CATALOG_PRODUCT", "Confira os campos e o motivo da alteração.", 422);
      return fail("CATALOG_UNAVAILABLE", "Não foi possível salvar o produto. Tente novamente.", 503);
    }
    const result = saveCatalogProductResponseSchema.safeParse({ data, request_id: requestId });
    if (!result.success) return fail("CATALOG_UNAVAILABLE", "Não foi possível confirmar o resultado. Tente novamente.", 503);
    return NextResponse.json(result.data, { status: value.id === null ? 201 : 200, headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("CATALOG_UNAVAILABLE", "Não foi possível salvar o produto. Tente novamente.", 503);
  }
}
