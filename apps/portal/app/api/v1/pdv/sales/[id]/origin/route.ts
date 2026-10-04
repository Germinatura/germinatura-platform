import { attributePdvSaleRequestSchema, attributePdvSaleResponseSchema, createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

interface RouteContext { params: Promise<{ id: string }>; }
const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });
const fail = (code: string, message: string, requestId: string, status: number) =>
  NextResponse.json(createApiError(code, message, requestId), { status, headers: headers(requestId) });

/** GROW-002: the seller records which campaign brought the customer of their PDV sale. Once per sale. */
export async function POST(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  const parsed = attributePdvSaleRequestSchema.safeParse(await request.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !parsed.success) return fail("INVALID_REQUEST", "Escolha a divulgação.", requestId, 422);
  try {
    await requirePermission("sales.create");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("attribute_pdv_sale", { p_sale_id: id, p_code: parsed.data.code, p_correlation_id: crypto.randomUUID() });
    if (error) {
      if (error.message.includes("SALE_ALREADY_ATTRIBUTED")) return fail("SALE_ALREADY_ATTRIBUTED", "Esta venda já tem outra origem.", requestId, 409);
      if (error.message.includes("SALE_NOT_ATTRIBUTABLE")) return fail("SALE_NOT_ATTRIBUTABLE", "Venda cancelada não recebe origem.", requestId, 409);
      if (error.message.includes("NOT_FOUND")) return fail("NOT_FOUND", "Venda ou divulgação não encontrada.", requestId, 404);
      if (error.code === "42501") return fail("FORBIDDEN", "Operação não autorizada.", requestId, 403);
      return fail("ATTRIBUTION_UNAVAILABLE", "Não foi possível registrar a origem.", requestId, 503);
    }
    const row = z.object({ sale_id: z.uuid(), campaign_code: z.string(), campaign_title: z.string() }).safeParse(data);
    if (!row.success) return fail("ATTRIBUTION_UNAVAILABLE", "Não foi possível registrar a origem.", requestId, 503);
    return NextResponse.json(attributePdvSaleResponseSchema.parse({
      data: { saleId: row.data.sale_id, campaignCode: row.data.campaign_code, campaignTitle: row.data.campaign_title }, request_id: requestId,
    }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return fail("ATTRIBUTION_UNAVAILABLE", "Não foi possível registrar a origem.", requestId, 503);
  }
}
