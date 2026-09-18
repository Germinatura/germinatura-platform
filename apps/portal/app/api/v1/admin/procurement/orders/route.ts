import { createApiError, createPurchaseOrderSchema, idempotencyKeySchema, purchaseOrderCommandResponseSchema, purchaseOrderQuerySchema, purchaseOrdersResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const rowSchema = z.array(z.object({
  id: z.uuid(), supplier_id: z.uuid(), status: z.enum(["OPEN", "CANCELLED"]),
  ordered_on: z.string(), expected_on: z.string().nullable(), freight_cents: z.number(),
  other_cost_cents: z.number(), items_subtotal_cents: z.number(), total_cents: z.number(),
  payment_method: z.string(), proof_reference: z.string().nullable(), notes: z.string().nullable(),
  cancellation_reason: z.string().nullable(), created_at: z.string(),
  suppliers: z.object({ name: z.string() }),
  purchase_order_items: z.array(z.object({ id: z.uuid(), product_id: z.uuid(), product_name: z.string(), product_sku: z.string(), quantity: z.number(), unit_cost_cents: z.number(), line_total_cents: z.number() })),
}));
const headers = (id: string) => ({ "Cache-Control": "no-store", "x-request-id": id });
const fail = (id: string, code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, id), { status, headers: headers(id) });

export async function GET(request: Request) {
  const id = createRequestId(request.headers);
  try {
    await requirePermission("procurement.manage");
    const parsed = purchaseOrderQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return fail(id, "INVALID_PURCHASE_QUERY", "Consulta de pedidos inválida.", 422);
    const client = await createAuthenticatedSupabaseClient(request);
    let query = client.from("purchase_orders")
      .select("id,supplier_id,status,ordered_on,expected_on,freight_cents,other_cost_cents,items_subtotal_cents,total_cents,payment_method,proof_reference,notes,cancellation_reason,created_at,suppliers(name),purchase_order_items(id,product_id,product_name,product_sku,quantity,unit_cost_cents,line_total_cents)")
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(21);
    if (parsed.data.status !== "ALL") query = query.eq("status", parsed.data.status);
    if (parsed.data.cursor) {
      const cursor = await client.from("purchase_orders").select("created_at").eq("id", parsed.data.cursor).maybeSingle();
      if (cursor.error || !cursor.data) return fail(id, "INVALID_PURCHASE_CURSOR", "Cursor de pedidos inválido.", 422);
      query = query.or(`created_at.lt.${cursor.data.created_at},and(created_at.eq.${cursor.data.created_at},id.lt.${parsed.data.cursor})`);
    }
    const { data, error } = await query;
    const rows = rowSchema.safeParse(data);
    if (error || !rows.success) return fail(id, "PROCUREMENT_UNAVAILABLE", "Não foi possível consultar pedidos.", 503);
    const page = rows.data.slice(0, 20);
    const result = purchaseOrdersResponseSchema.safeParse({
      data: page.map((row) => ({
        id: row.id, supplierId: row.supplier_id, supplierName: row.suppliers.name, status: row.status,
        orderedOn: row.ordered_on, expectedOn: row.expected_on, freightCents: row.freight_cents,
        otherCostCents: row.other_cost_cents, itemsSubtotalCents: row.items_subtotal_cents,
        totalCents: row.total_cents, paymentMethod: row.payment_method, proofReference: row.proof_reference,
        notes: row.notes, cancellationReason: row.cancellation_reason, createdAt: row.created_at,
        items: row.purchase_order_items.map((item) => ({ id: item.id, productId: item.product_id,
          productName: item.product_name, productSku: item.product_sku, quantity: item.quantity,
          unitCostCents: item.unit_cost_cents, lineTotalCents: item.line_total_cents })),
      })),
      nextCursor: rows.data.length > 20 ? page.at(-1)?.id ?? null : null, request_id: id,
    });
    if (!result.success) return fail(id, "PROCUREMENT_UNAVAILABLE", "Dados de pedidos inválidos.", 503);
    return NextResponse.json(result.data, { headers: headers(id) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(id, error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail(id, "PROCUREMENT_UNAVAILABLE", "Não foi possível consultar pedidos.", 503);
  }
}

export async function POST(request: Request) {
  const id = createRequestId(request.headers);
  try {
    await requirePermission("procurement.manage");
    const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    const parsed = createPurchaseOrderSchema.safeParse(await request.json().catch(() => null));
    if (!key.success || !parsed.success) return fail(id, "INVALID_PURCHASE_ORDER", "Confira fornecedor, itens, custos e motivo.", 422);
    const value = parsed.data;
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("create_purchase_order", {
      p_supplier_id: value.supplierId, p_ordered_on: value.orderedOn, p_expected_on: value.expectedOn,
      p_freight_cents: value.freightCents, p_other_cost_cents: value.otherCostCents,
      p_payment_method: value.paymentMethod, p_proof_reference: value.proofReference,
      p_notes: value.notes, p_items: value.items, p_reason: value.reason,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      if (error.code === "42501") return fail(id, "FORBIDDEN", "Permissão insuficiente.", 403);
      if (["IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_IN_PROGRESS"].includes(error.message)) return fail(id, error.message, "A solicitação já foi usada ou está em processamento.", 409);
      if (["SUPPLIER_INACTIVE", "PRODUCT_INACTIVE"].includes(error.message)) return fail(id, error.message, "Fornecedor ou produto indisponível. Atualize os cadastros.", 409);
      if (error.code === "23505") return fail(id, "DUPLICATE_PURCHASE_ITEM", "Um produto foi informado mais de uma vez.", 422);
      if (["22023", "23514", "22P02", "22003"].includes(error.code)) return fail(id, "INVALID_PURCHASE_ORDER", "Confira fornecedor, itens e custos.", 422);
      return fail(id, "PROCUREMENT_UNAVAILABLE", "Não foi possível registrar o pedido.", 503);
    }
    const result = purchaseOrderCommandResponseSchema.safeParse({ data, request_id: id });
    if (!result.success) return fail(id, "PROCUREMENT_UNAVAILABLE", "Não foi possível confirmar o pedido.", 503);
    return NextResponse.json(result.data, { status: 201, headers: headers(id) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(id, error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail(id, "PROCUREMENT_UNAVAILABLE", "Não foi possível registrar o pedido.", 503);
  }
}
