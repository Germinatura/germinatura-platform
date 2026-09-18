import { createApiError, createPurchaseReceiptSchema, idempotencyKeySchema, purchaseReceiptCommandResponseSchema, purchaseReceiptQuerySchema, purchaseReceiptsResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const rowSchema = z.array(z.object({
  id: z.uuid(), order_id: z.uuid(), order_item_id: z.uuid(), product_id: z.uuid(),
  quantity: z.number(), received_on: z.string(), base_cost_cents: z.number(),
  allocated_extra_cents: z.number(), total_cost_cents: z.number(), movement_id: z.uuid(), created_at: z.string(),
  inventory_lots: z.object({ id: z.uuid(), lot_code: z.string(), manufactured_on: z.string().nullable(), expires_on: z.string().nullable() }),
  purchase_payable_entries: z.object({ id: z.uuid() }),
}));
const headers = (id: string) => ({ "Cache-Control": "no-store", "x-request-id": id });
const fail = (id: string, code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, id), { status, headers: headers(id) });

export async function GET(request: Request) {
  const id = createRequestId(request.headers);
  try {
    await requirePermission("procurement.manage");
    const parsed = purchaseReceiptQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return fail(id, "INVALID_PURCHASE_RECEIPT_QUERY", "Consulta de recebimentos inválida.", 422);
    const client = await createAuthenticatedSupabaseClient(request);
    let query = client.from("purchase_receipts")
      .select("id,order_id,order_item_id,product_id,quantity,received_on,base_cost_cents,allocated_extra_cents,total_cost_cents,movement_id,created_at,inventory_lots(id,lot_code,manufactured_on,expires_on),purchase_payable_entries(id)")
      .eq("order_id", parsed.data.orderId).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(21);
    if (parsed.data.cursor) {
      const cursor = await client.from("purchase_receipts").select("created_at").eq("order_id", parsed.data.orderId).eq("id", parsed.data.cursor).maybeSingle();
      if (cursor.error || !cursor.data) return fail(id, "INVALID_PURCHASE_RECEIPT_CURSOR", "Cursor de recebimentos inválido.", 422);
      query = query.or(`created_at.lt.${cursor.data.created_at},and(created_at.eq.${cursor.data.created_at},id.lt.${parsed.data.cursor})`);
    }
    const [{ data, error }, progressQuery] = await Promise.all([
      query, client.from("purchase_order_item_progress").select("order_item_id,ordered_quantity,received_quantity").eq("order_id", parsed.data.orderId),
    ]);
    const rows = rowSchema.safeParse(data);
    const progress = z.array(z.object({ order_item_id: z.uuid(), ordered_quantity: z.number(), received_quantity: z.number() })).safeParse(progressQuery.data);
    if (error || !rows.success || progressQuery.error || !progress.success) return fail(id, "PROCUREMENT_UNAVAILABLE", "Não foi possível consultar recebimentos.", 503);
    const page = rows.data.slice(0, 20);
    const result = purchaseReceiptsResponseSchema.safeParse({
      data: page.map((row) => ({ id: row.id, orderId: row.order_id, orderItemId: row.order_item_id,
        productId: row.product_id, quantity: row.quantity, receivedOn: row.received_on,
        baseCostCents: row.base_cost_cents, allocatedExtraCents: row.allocated_extra_cents,
        totalCostCents: row.total_cost_cents, movementId: row.movement_id, createdAt: row.created_at,
        lot: { id: row.inventory_lots.id, code: row.inventory_lots.lot_code,
          manufacturedOn: row.inventory_lots.manufactured_on, expiresOn: row.inventory_lots.expires_on },
        payableId: row.purchase_payable_entries.id })),
      nextCursor: rows.data.length > 20 ? page.at(-1)?.id ?? null : null, request_id: id,
      progress: progress.data.map((item) => ({ orderItemId: item.order_item_id, orderedQuantity: item.ordered_quantity, receivedQuantity: item.received_quantity })),
    });
    if (!result.success) return fail(id, "PROCUREMENT_UNAVAILABLE", "Dados de recebimentos inválidos.", 503);
    return NextResponse.json(result.data, { headers: headers(id) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(id, error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail(id, "PROCUREMENT_UNAVAILABLE", "Não foi possível consultar recebimentos.", 503);
  }
}

export async function POST(request: Request) {
  const id = createRequestId(request.headers);
  try {
    await requirePermission("procurement.manage");
    const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    const parsed = createPurchaseReceiptSchema.safeParse(await request.json().catch(() => null));
    if (!key.success || !parsed.success) return fail(id, "INVALID_PURCHASE_RECEIPT", "Confira pedido, item, quantidade, lote, datas e motivo.", 422);
    const value = parsed.data;
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("receive_purchase_order_item", {
      p_order_id: value.orderId, p_order_item_id: value.orderItemId, p_quantity: value.quantity,
      p_received_on: value.receivedOn, p_lot_code: value.lotCode, p_manufactured_on: value.manufacturedOn,
      p_expires_on: value.expiresOn, p_reason: value.reason, p_idempotency_key: key.data,
      p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      if (error.code === "42501") return fail(id, "FORBIDDEN", "Permissão insuficiente.", 403);
      if (["PURCHASE_ORDER_NOT_FOUND", "PURCHASE_ITEM_NOT_FOUND"].includes(error.message)) return fail(id, error.message, "Pedido ou item não encontrado.", 404);
      if (["PURCHASE_ORDER_NOT_OPEN", "PURCHASE_QUANTITY_EXCEEDED", "IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_IN_PROGRESS"].includes(error.message)) return fail(id, error.message, "Pedido alterado ou quantidade já recebida. Atualize a página.", 409);
      if (error.message === "LOT_CODE_REQUIRED" || ["22023", "23514", "22003"].includes(error.code)) return fail(id, "INVALID_PURCHASE_RECEIPT", "Confira lote, datas e quantidade.", 422);
      return fail(id, "PROCUREMENT_UNAVAILABLE", "Não foi possível registrar o recebimento.", 503);
    }
    const result = purchaseReceiptCommandResponseSchema.safeParse({ data, request_id: id });
    if (!result.success) return fail(id, "PROCUREMENT_UNAVAILABLE", "Não foi possível confirmar o recebimento.", 503);
    return NextResponse.json(result.data, { status: 201, headers: headers(id) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(id, error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail(id, "PROCUREMENT_UNAVAILABLE", "Não foi possível registrar o recebimento.", 503);
  }
}
