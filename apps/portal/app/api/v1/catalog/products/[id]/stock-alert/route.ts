import { createApiError, setStockAlertRequestSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requireSession } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

interface RouteContext { params: Promise<{ id: string }>; }
const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });
const fail = (code: string, message: string, requestId: string, status: number) =>
  NextResponse.json(createApiError(code, message, requestId), { status, headers: headers(requestId) });

/** NOTIF-004: "avise-me quando voltar" on (one-shot) or off for an unavailable published product. */
export async function PUT(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  const parsed = setStockAlertRequestSchema.safeParse(await request.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !parsed.success) return fail("INVALID_STOCK_ALERT", "Aviso inválido.", requestId, 422);
  try {
    await requireSession();
    const client = await createAuthenticatedSupabaseClient(request);
    const { error } = await client.rpc("set_stock_alert", { p_product_id: id, p_enabled: parsed.data.enabled });
    if (error?.message.includes("PRODUCT_AVAILABLE")) return fail("PRODUCT_AVAILABLE", "O produto já está disponível.", requestId, 409);
    if (error?.message.includes("INVALID_STOCK_ALERT")) return fail("NOT_FOUND", "Produto não encontrado.", requestId, 404);
    if (error) return fail("STOCK_ALERT_UNAVAILABLE", "Não foi possível salvar o aviso.", requestId, 503);
    return NextResponse.json({ data: { productId: id, enabled: parsed.data.enabled }, request_id: requestId }, { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return fail("STOCK_ALERT_UNAVAILABLE", "Não foi possível salvar o aviso.", requestId, 503);
  }
}
