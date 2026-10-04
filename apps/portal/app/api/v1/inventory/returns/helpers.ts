import { createApiError, stockReturnContextResponseSchema } from "@germinatura/contracts";
import { NextResponse } from "next/server";

export const returnHeaders = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });
export const returnFail = (requestId: string, code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers: returnHeaders(requestId) });
export function returnError(requestId: string, error: { code?: string; message: string }) {
  if (error.code === "42501") return returnFail(requestId, "FORBIDDEN", "Permissão insuficiente para esta devolução.", 403);
  if (["STOCK_CONFLICT", "RETURN_REQUEST_ALREADY_RESOLVED", "IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_IN_PROGRESS"].includes(error.message)) return returnFail(requestId, error.message, "O estoque mudou, a solicitação foi resolvida ou a ação ainda está em processamento.", 409);
  if (["PRODUCT_NOT_FOUND", "RETURN_REQUEST_NOT_FOUND", "SELLER_LOCATION_NOT_FOUND", "CENTRAL_LOCATION_NOT_FOUND"].includes(error.message)) return returnFail(requestId, error.message, "Produto, localização ou devolução não foi encontrada.", 404);
  if (error.code === "22023") return returnFail(requestId, "INVALID_STOCK_RETURN", "Confira produto, quantidade, ação e motivo.", 422);
  return returnFail(requestId, "INVENTORY_UNAVAILABLE", "Não foi possível processar a devolução.", 503);
}
function mapRequest(row: Record<string, unknown>) { return {
  id: row.id, fromLocationId: row.from_location_id, fromLocationName: row.from_location_name,
  toLocationId: row.to_location_id, toLocationName: row.to_location_name, productId: row.product_id,
  productName: row.product_name, productSku: row.product_sku, quantity: row.quantity, status: row.status,
  requestedBy: row.requested_by, requestReason: row.request_reason, decisionReason: row.decision_reason,
  movementId: row.movement_id, createdAt: row.created_at, decidedAt: row.decided_at,
}; }
export function mapContext(data: unknown, requestId: string) {
  const record = data as Record<string, unknown> | null;
  const options = Array.isArray(record?.options) ? record.options : [];
  const requests = Array.isArray(record?.requests) ? record.requests : [];
  return stockReturnContextResponseSchema.safeParse({ data: {
    ownLocationId: record?.own_location_id ?? null, nextCursor: record?.next_cursor ?? null,
    options: options.map((value) => { const row=value as Record<string,unknown>; return { productId:row.product_id,productName:row.product_name,productSku:row.product_sku,availableQuantity:row.available_quantity }; }),
    requests: requests.map((value) => mapRequest(value as Record<string,unknown>)),
  }, request_id: requestId });
}
export const uuidPath = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
