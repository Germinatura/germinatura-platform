import { createApiError, idempotencyKeySchema, saveCatalogCategorySchema, saveCatalogCategoryResponseSchema } from "@germinatura/contracts";
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
    const parsed = saveCatalogCategorySchema.safeParse(await request.json().catch(() => null));
    if (!key.success || !parsed.success) return fail("INVALID_CATALOG_CATEGORY", "Confira os campos e o motivo da alteração.", 422);
    const value = parsed.data;
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("save_catalog_category", {
      p_category_id: value.id, p_expected_revision: value.expectedRevision, p_name: value.name,
      p_slug: value.slug, p_active: value.active, p_sort_order: value.sortOrder, p_reason: value.reason,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      if (error.code === "42501") return fail("FORBIDDEN", "Permissão insuficiente.", 403);
      if (error.message === "CATEGORY_NOT_FOUND") return fail("CATEGORY_NOT_FOUND", "Categoria não encontrada.", 404);
      if (error.message === "CATEGORY_REVISION_CONFLICT") return fail("CATEGORY_REVISION_CONFLICT", "Esta categoria foi alterada em outra sessão. Atualize a página antes de editar novamente.", 409);
      if (error.code === "23505") return fail("CATEGORY_SLUG_CONFLICT", "Este identificador já pertence a outra categoria.", 409);
      if (error.message === "IDEMPOTENCY_CONFLICT" || error.message === "IDEMPOTENCY_IN_PROGRESS") return fail(error.message, "A solicitação já está em processamento ou foi usada com outro conteúdo.", 409);
      if (error.code === "22023" || error.code === "23514") return fail("INVALID_CATALOG_CATEGORY", "Confira os campos e o motivo da alteração.", 422);
      return fail("CATALOG_UNAVAILABLE", "Não foi possível salvar a categoria. Tente novamente.", 503);
    }
    const result = saveCatalogCategoryResponseSchema.safeParse({ data, request_id: requestId });
    if (!result.success) return fail("CATALOG_UNAVAILABLE", "Não foi possível confirmar o resultado. Tente novamente.", 503);
    return NextResponse.json(result.data, { status: value.id === null ? 201 : 200, headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("CATALOG_UNAVAILABLE", "Não foi possível salvar a categoria. Tente novamente.", 503);
  }
}
