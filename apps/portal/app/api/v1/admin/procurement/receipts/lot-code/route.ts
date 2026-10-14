import { createApiError, reservePurchaseLotCodeResponseSchema, reservePurchaseLotCodeSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const headers = (id: string) => ({ "Cache-Control": "no-store", "x-request-id": id });
const fail = (id: string, code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, id), { status, headers: headers(id) });
const resultSchema = z.object({ lot_code: z.string(), prefix: z.string(), sequence: z.number().int() });

/**
 * H1: "Gerar lote". The database reserves the number under a lock (never the same code for two people receiving at the
 * same time); the person may still edit the code before registering the delivery. Nothing else is written.
 */
export async function POST(request: Request) {
  const id = createRequestId(request.headers);
  const parsed = reservePurchaseLotCodeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail(id, "INVALID_LOT_CODE_REQUEST", "Informe o item e a data do recebimento.", 422);
  try {
    await requirePermission("procurement.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("reserve_purchase_lot_code", { p_order_item_id: parsed.data.orderItemId, p_received_on: parsed.data.receivedOn });
    if (error) {
      if (error.message.includes("PROCUREMENT_MANAGE_FORBIDDEN")) return fail(id, "FORBIDDEN", "Permissão insuficiente", 403);
      if (error.message.includes("PURCHASE_ORDER_ITEM_NOT_FOUND")) return fail(id, "PURCHASE_ORDER_ITEM_NOT_FOUND", "Item do pedido não encontrado.", 404);
      if (error.message.includes("INVALID_LOT_CODE_REQUEST")) return fail(id, "INVALID_LOT_CODE_REQUEST", "A data do recebimento não pode estar no futuro.", 422);
      if (error.message.includes("COHORT_REQUIRED")) return fail(id, "COHORT_REQUIRED", "Selecione uma turma para receber mercadorias.", 409);
      return fail(id, "PROCUREMENT_UNAVAILABLE", "Não foi possível gerar o lote.", 503);
    }
    const row = resultSchema.safeParse(data);
    if (!row.success) return fail(id, "PROCUREMENT_UNAVAILABLE", "Não foi possível gerar o lote.", 503);
    return NextResponse.json(reservePurchaseLotCodeResponseSchema.parse({
      data: { lotCode: row.data.lot_code, prefix: row.data.prefix, sequence: row.data.sequence }, request_id: id,
    }), { headers: headers(id) });
  } catch (cause) {
    if (cause instanceof AuthorizationError) return fail(id, cause.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", cause.message, cause.status);
    return fail(id, "PROCUREMENT_UNAVAILABLE", "Não foi possível gerar o lote.", 503);
  }
}
