import { createApiError, inventoryCountContextResponseSchema } from "@germinatura/contracts";
import { NextResponse } from "next/server";

export const countHeaders = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });
export const countFail = (requestId: string, code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers: countHeaders(requestId) });
export function countError(requestId: string, error: { code?: string; message: string }) {
  if (error.code === "42501") return countFail(requestId, "FORBIDDEN", "Permissão insuficiente para esta contagem.", 403);
  if (["INVENTORY_COUNT_STALE", "INVENTORY_COUNT_RESERVED_CONFLICT", "INVENTORY_COUNT_ALREADY_RESOLVED", "IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_IN_PROGRESS"].includes(error.message)) return countFail(requestId, error.message, "O estoque mudou, possui reservas incompatíveis ou a contagem já foi resolvida.", 409);
  if (["PRODUCT_NOT_FOUND", "INVENTORY_COUNT_NOT_FOUND", "STOCK_LOCATION_NOT_FOUND"].includes(error.message)) return countFail(requestId, error.message, "Produto, localização ou contagem não foi encontrada.", 404);
  if (error.code === "22023") return countFail(requestId, "INVALID_INVENTORY_COUNT", "Confira a localização, as quantidades e a justificativa.", 422);
  return countFail(requestId, "INVENTORY_UNAVAILABLE", "Não foi possível processar a contagem.", 503);
}

export function mapCountContext(data: unknown, requestId: string) {
  const record = data as Record<string, unknown> | null;
  const rows = (value: unknown) => Array.isArray(value) ? value as Record<string, unknown>[] : [];
  return inventoryCountContextResponseSchema.safeParse({ data: {
    selectedLocationId: record?.selected_location_id,
    locations: rows(record?.locations).map((row) => ({ id: row.id, name: row.name, locationType: row.location_type })),
    balances: rows(record?.balances).map((row) => ({ productId: row.product_id, productName: row.product_name, productSku: row.product_sku, onHandQuantity: row.on_hand_quantity, reservedQuantity: row.reserved_quantity, availableQuantity: row.available_quantity })),
    counts: rows(record?.counts).map((row) => ({ id: row.id, locationId: row.location_id, locationName: row.location_name, status: row.status, observation: row.observation, submittedBy: row.submitted_by, decisionReason: row.decision_reason, createdAt: row.created_at, decidedAt: row.decided_at, items: rows(row.items).map((item) => ({ productId: item.product_id, productName: item.product_name, productSku: item.product_sku, expectedOnHandQuantity: item.expected_on_hand_quantity, expectedReservedQuantity: item.expected_reserved_quantity, countedOnHandQuantity: item.counted_on_hand_quantity, differenceQuantity: item.difference_quantity, movementId: item.movement_id })) })),
    movements: rows(record?.movements).map((row) => ({ id: row.id, movementType: row.movement_type, reason: row.reason, createdAt: row.created_at, items: rows(row.items).map((item) => ({ productId: item.product_id, productName: item.product_name, quantity: item.quantity })) })),
    nextCursor: record?.next_cursor ?? null,
  }, request_id: requestId });
}

export const uuidPath = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
