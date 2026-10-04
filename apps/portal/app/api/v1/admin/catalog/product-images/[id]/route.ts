import { createApiError, idempotencyKeySchema, removeCatalogProductImageResponseSchema, removeCatalogProductImageSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

function fail(code: string, message: string, requestId: string, status: number) {
  return NextResponse.json(createApiError(code, message, requestId), { status, headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("catalog.manage");
    const { id } = await context.params;
    const imageId = z.uuid().safeParse(id);
    const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    const parsed = removeCatalogProductImageSchema.safeParse(await request.json().catch(() => null));
    if (!imageId.success || !key.success || !parsed.success) return fail("INVALID_CATALOG_PRODUCT_IMAGE_REMOVAL", "Confira a imagem e o motivo.", requestId, 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("begin_remove_catalog_product_image", {
      p_image_id: imageId.data, p_product_id: parsed.data.productId,
      p_expected_product_revision: parsed.data.expectedRevision, p_reason: parsed.data.reason,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      if (error.code === "42501") return fail("FORBIDDEN", "Permissão insuficiente.", requestId, 403);
      if (error.message === "PRODUCT_IMAGE_NOT_FOUND" || error.message === "PRODUCT_NOT_FOUND") return fail(error.message, "Imagem ou produto não encontrado.", requestId, 404);
      if (["PRODUCT_REVISION_CONFLICT", "IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_IN_PROGRESS"].includes(error.message)) return fail(error.message, "O produto mudou em outra sessão. Atualize a página.", requestId, 409);
      return fail("CATALOG_UNAVAILABLE", "Não foi possível iniciar a remoção. Tente novamente.", requestId, 503);
    }
    const result = removeCatalogProductImageResponseSchema.safeParse({ data, request_id: requestId });
    if (!result.success) return fail("CATALOG_UNAVAILABLE", "Não foi possível confirmar a remoção. Atualize a página.", requestId, 503);
    const removed = await client.storage.from("product-images").remove([result.data.data.objectPath]);
    if (removed.error) return fail("IMAGE_CLEANUP_PENDING", "A imagem foi ocultada e a exclusão física ficou pendente. Repita a remoção.", requestId, 503);
    const finalized = await client.rpc("finish_remove_catalog_product_image", { p_image_id: imageId.data, p_correlation_id: crypto.randomUUID() });
    if (finalized.error) return fail("IMAGE_CLEANUP_PENDING", "A imagem foi excluída; atualize a página para confirmar.", requestId, 503);
    return NextResponse.json(result.data, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return fail("CATALOG_UNAVAILABLE", "Não foi possível remover a imagem. Tente novamente.", requestId, 503);
  }
}
