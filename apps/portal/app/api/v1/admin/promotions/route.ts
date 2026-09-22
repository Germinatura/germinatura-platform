import { createApiError, idempotencyKeySchema, saveQuantityPricePromotionResponseSchema, saveQuantityPricePromotionSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const fail = (code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers });
  try {
    await requirePermission("catalog.manage");
    const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    const parsed = saveQuantityPricePromotionSchema.safeParse(await request.json().catch(() => null));
    if (!key.success || !parsed.success) return fail("INVALID_PROMOTION", "Confira os campos, vigência, produtos, canais e motivo.", 422);
    const value = parsed.data;
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("save_quantity_price_promotion", {
      p_promotion_id: value.id, p_expected_revision: value.expectedRevision, p_code: value.code,
      p_name: value.name, p_description: value.description, p_active: value.active,
      p_publicable: value.publicable, p_priority: value.priority, p_cumulative: value.cumulative,
      p_valid_from: value.validFrom, p_valid_to: value.validTo,
      p_global_redemption_limit: value.globalRedemptionLimit,
      p_per_user_redemption_limit: value.perUserRedemptionLimit,
      p_product_ids: value.productIds, p_channels: value.channels,
      p_group_quantity: value.rule.groupQuantity, p_group_price_cents: value.rule.groupPriceCents,
      p_max_groups_per_line: value.rule.maxGroupsPerLine, p_reason: value.reason,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      if (error.code === "42501") return fail("FORBIDDEN", "Permissão insuficiente.", 403);
      if (error.message === "PROMOTION_NOT_FOUND" || error.message === "PROMOTION_PRODUCT_NOT_FOUND") return fail(error.message, "Promoção ou produto não encontrado.", 404);
      if (["PROMOTION_REVISION_CONFLICT", "IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_IN_PROGRESS"].includes(error.message)) return fail(error.message, "A promoção mudou ou a solicitação já está em processamento. Atualize a página.", 409);
      if (error.code === "23505") return fail("PROMOTION_CODE_CONFLICT", "Este código já pertence a outra promoção.", 409);
      if (["22023", "23514", "22003"].includes(error.code)) return fail("INVALID_PROMOTION", "Confira os campos, vigência, produtos, canais e motivo.", 422);
      return fail("PROMOTION_UNAVAILABLE", "Não foi possível salvar a promoção.", 503);
    }
    const result = saveQuantityPricePromotionResponseSchema.safeParse({ data, request_id: requestId });
    if (!result.success) return fail("PROMOTION_UNAVAILABLE", "Não foi possível confirmar a promoção.", 503);
    return NextResponse.json(result.data, { status: value.id === null ? 201 : 200, headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("PROMOTION_UNAVAILABLE", "Não foi possível salvar a promoção.", 503);
  }
}
