import { createApiError, inventoryLotQuerySchema, inventoryLotsResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const positionsSchema = z.array(z.object({
  lot_id: z.uuid(), lot_code: z.string(), origin_type: z.string(), product_id: z.uuid(),
  product_sku: z.string(), product_name: z.string(), location_id: z.uuid(), location_name: z.string(),
  on_hand_quantity: z.number(), manufactured_on: z.string().nullable(), expires_on: z.string().nullable(),
  received_quantity: z.number(), total_cost_cents: z.number().nullable(), consumed_quantity: z.number(),
  consumed_cost_cents: z.number().nullable(), created_at: z.string(),
}));
const historySchema = z.array(z.object({
  id: z.uuid(), lot_id: z.uuid(), quantity: z.number(), allocated_cost_cents: z.number().nullable(),
  movement_id: z.uuid(), movement_type: z.string(), from_location_id: z.uuid().nullable(),
  to_location_id: z.uuid().nullable(), source_type: z.string().nullable(), source_id: z.string().nullable(),
  reason: z.string(), created_at: z.string(),
}));
const headers = (id: string) => ({ "Cache-Control": "no-store", "x-request-id": id });

export async function GET(request: Request) {
  const id = createRequestId(request.headers);
  const fail = (code: string, message: string, status: number) => NextResponse.json(
    createApiError(code, message, id), { status, headers: headers(id) },
  );
  try {
    await requirePermission("inventory.manage");
    const parsed = inventoryLotQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success || (parsed.success && parsed.data.historyCursor && !parsed.data.lotId)) {
      return fail("INVALID_LOT_QUERY", "Consulta de lotes inválida.", 422);
    }
    const params = parsed.data;
    const client = await createAuthenticatedSupabaseClient(request);
    const cursor = params.positionCursor?.split(":");
    const positionsResult = params.lotId
      ? await client.from("inventory_lot_positions").select("*").eq("lot_id", params.lotId).order("location_id")
      : await client.rpc("search_inventory_lot_positions", {
        p_query: params.query ?? null,
        p_cursor_lot: cursor?.[0] ?? null,
        p_cursor_location: cursor?.[1] ?? null,
        p_limit: 21,
      });
    const positions = positionsSchema.safeParse(positionsResult.data);
    if (positionsResult.error || !positions.success) return fail("LOT_TRACEABILITY_UNAVAILABLE", "Não foi possível consultar os lotes.", 503);
    const page = positions.data.slice(0, 20);
    const nextPositionCursor = !params.lotId && positions.data.length > 20
      ? `${page[19].lot_id}:${page[19].location_id}` : null;

    let history: z.infer<typeof historySchema> = [];
    let nextHistoryCursor: string | null = null;
    if (params.lotId) {
      let historyQuery = client.from("inventory_lot_history").select("*").eq("lot_id", params.lotId)
        .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(21);
      if (params.historyCursor) {
        const anchor = await client.from("inventory_lot_history").select("created_at")
          .eq("id", params.historyCursor).eq("lot_id", params.lotId).maybeSingle();
        if (anchor.error || !anchor.data) return fail("INVALID_LOT_CURSOR", "Cursor de histórico inválido.", 422);
        historyQuery = historyQuery.or(`created_at.lt.${anchor.data.created_at},and(created_at.eq.${anchor.data.created_at},id.lt.${params.historyCursor})`);
      }
      const historyResult = await historyQuery;
      const parsedHistory = historySchema.safeParse(historyResult.data);
      if (historyResult.error || !parsedHistory.success) return fail("LOT_TRACEABILITY_UNAVAILABLE", "Não foi possível consultar o histórico do lote.", 503);
      history = parsedHistory.data.slice(0, 20);
      nextHistoryCursor = parsedHistory.data.length > 20 ? history.at(-1)?.id ?? null : null;
    }
    const result = inventoryLotsResponseSchema.safeParse({
      data: page.map((row) => ({
        lotId: row.lot_id, lotCode: row.lot_code, originType: row.origin_type, productId: row.product_id,
        productSku: row.product_sku, productName: row.product_name, locationId: row.location_id,
        locationName: row.location_name, onHandQuantity: row.on_hand_quantity,
        manufacturedOn: row.manufactured_on, expiresOn: row.expires_on,
        receivedQuantity: row.received_quantity, totalCostCents: row.total_cost_cents,
        consumedQuantity: row.consumed_quantity, consumedCostCents: row.consumed_cost_cents, createdAt: row.created_at,
      })),
      history: history.map((row) => ({
        id: row.id, lotId: row.lot_id, quantity: row.quantity, allocatedCostCents: row.allocated_cost_cents,
        movementId: row.movement_id, movementType: row.movement_type, fromLocationId: row.from_location_id,
        toLocationId: row.to_location_id, sourceType: row.source_type, sourceId: row.source_id,
        reason: row.reason, createdAt: row.created_at,
      })),
      nextPositionCursor, nextHistoryCursor, request_id: id,
    });
    if (!result.success) return fail("LOT_TRACEABILITY_UNAVAILABLE", "Dados de rastreabilidade inválidos.", 503);
    return NextResponse.json(result.data, { headers: headers(id) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("LOT_TRACEABILITY_UNAVAILABLE", "Não foi possível consultar a rastreabilidade.", 503);
  }
}
