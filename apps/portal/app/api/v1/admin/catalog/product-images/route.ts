import {
  catalogProductImageMutationResponseSchema, createApiError, idempotencyKeySchema,
  reorderCatalogProductImagesResponseSchema, reorderCatalogProductImagesSchema,
  uploadCatalogProductImageSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { CATALOG_IMAGE_MAX_BYTES, detectCatalogImageFile, storageConflict } from "@/lib/catalog-image-file";

function fail(code: string, message: string, requestId: string, status: number) {
  return NextResponse.json(createApiError(code, message, requestId), { status, headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
}

function rpcFailure(error: { code?: string; message?: string }, requestId: string) {
  if (error.code === "42501") return fail("FORBIDDEN", "Permissão insuficiente.", requestId, 403);
  if (error.message === "PRODUCT_NOT_FOUND") return fail(error.message, "Produto não encontrado.", requestId, 404);
  if (error.message === "PRODUCT_IMAGE_LIMIT_REACHED") return fail(error.message, "Cada produto aceita até seis imagens.", requestId, 409);
  if (["PRODUCT_REVISION_CONFLICT", "IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_IN_PROGRESS"].includes(error.message ?? "")) {
    return fail(error.message ?? "CATALOG_CONFLICT", "O produto mudou em outra sessão ou a solicitação já está em processamento. Atualize a página.", requestId, 409);
  }
  if (error.message === "PRODUCT_IMAGE_SET_CHANGED") return fail(error.message, "A lista de imagens mudou. Atualize a página.", requestId, 409);
  if (error.code === "22023" || error.message === "PRODUCT_IMAGE_OBJECT_INVALID") return fail("INVALID_CATALOG_PRODUCT_IMAGE", "A imagem ou seus metadados são inválidos.", requestId, 422);
  return fail("CATALOG_UNAVAILABLE", "Não foi possível atualizar as imagens. Tente novamente.", requestId, 503);
}

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("catalog.manage");
    const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    const parsed = uploadCatalogProductImageSchema.safeParse({
      imageId: form?.get("imageId"), productId: form?.get("productId"),
      expectedRevision: Number(form?.get("expectedRevision")), altText: form?.get("altText"), reason: form?.get("reason"),
    });
    if (!key.success || !parsed.success || !(file instanceof File) || file.size < 1 || file.size > CATALOG_IMAGE_MAX_BYTES) {
      return fail("INVALID_CATALOG_PRODUCT_IMAGE", "Envie JPG, PNG ou WebP de até 5 MB e confira os metadados.", requestId, 422);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = detectCatalogImageFile(bytes);
    if (!type || (file.type && file.type !== type.mimeType)) return fail("INVALID_CATALOG_PRODUCT_IMAGE", "O conteúdo do arquivo não corresponde a uma imagem JPG, PNG ou WebP.", requestId, 422);
    const value = parsed.data;
    const objectPath = `products/${value.productId}/${value.imageId}.${type.extension}`;
    const client = await createAuthenticatedSupabaseClient(request);
    const uploaded = await client.storage.from("product-images").upload(objectPath, bytes, {
      cacheControl: "31536000", contentType: type.mimeType, upsert: false,
    });
    if (uploaded.error && !storageConflict(uploaded.error)) return fail("IMAGE_STORAGE_UNAVAILABLE", "Não foi possível enviar a imagem. Tente novamente.", requestId, 503);
    const correlationId = crypto.randomUUID();
    const { data, error } = await client.rpc("add_catalog_product_image", {
      p_product_id: value.productId, p_expected_product_revision: value.expectedRevision,
      p_image_id: value.imageId, p_object_path: objectPath, p_alt_text: value.altText,
      p_reason: value.reason, p_idempotency_key: key.data, p_correlation_id: correlationId,
    });
    if (error) {
      if (!uploaded.error) await client.storage.from("product-images").remove([objectPath]);
      return rpcFailure(error, requestId);
    }
    const publicUrl = client.storage.from("product-images").getPublicUrl(objectPath).data.publicUrl;
    const result = catalogProductImageMutationResponseSchema.safeParse({ data: { ...data, publicUrl }, request_id: requestId });
    if (!result.success) return fail("CATALOG_UNAVAILABLE", "Não foi possível confirmar o envio. Atualize a página.", requestId, 503);
    return NextResponse.json(result.data, { status: 201, headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return fail("CATALOG_UNAVAILABLE", "Não foi possível enviar a imagem. Tente novamente.", requestId, 503);
  }
}

export async function PUT(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("catalog.manage");
    const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    const parsed = reorderCatalogProductImagesSchema.safeParse(await request.json().catch(() => null));
    if (!key.success || !parsed.success) return fail("INVALID_CATALOG_PRODUCT_IMAGE_ORDER", "Confira a ordem e o motivo.", requestId, 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("reorder_catalog_product_images", {
      p_product_id: parsed.data.productId, p_expected_product_revision: parsed.data.expectedRevision,
      p_image_ids: parsed.data.imageIds, p_reason: parsed.data.reason,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return rpcFailure(error, requestId);
    const result = reorderCatalogProductImagesResponseSchema.safeParse({ data, request_id: requestId });
    return result.success ? NextResponse.json(result.data, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } })
      : fail("CATALOG_UNAVAILABLE", "Não foi possível confirmar a ordem. Atualize a página.", requestId, 503);
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return fail("CATALOG_UNAVAILABLE", "Não foi possível ordenar as imagens. Tente novamente.", requestId, 503);
  }
}
