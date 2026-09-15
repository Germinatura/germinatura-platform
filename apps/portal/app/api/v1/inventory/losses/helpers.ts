import { createApiError, stockLossContextResponseSchema } from "@germinatura/contracts";
import { NextResponse } from "next/server";

export const lossHeaders = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });
export const lossFail = (requestId: string, code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers: lossHeaders(requestId) });
export function lossError(requestId: string, error: { code?: string; message: string }) {
  if (error.code === "42501") return lossFail(requestId, "FORBIDDEN", "Permissão insuficiente para esta perda.", 403);
  if (["STOCK_CONFLICT", "STOCK_LOSS_ALREADY_RESOLVED", "IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_IN_PROGRESS"].includes(error.message)) return lossFail(requestId, error.message, "O estoque mudou, a perda foi resolvida ou a ação ainda está em processamento.", 409);
  if (["PRODUCT_NOT_FOUND", "STOCK_LOSS_NOT_FOUND", "SELLER_LOCATION_NOT_FOUND", "STOCK_LOSS_PHOTO_NOT_FOUND"].includes(error.message)) return lossFail(requestId, error.message, "Produto, localização, foto ou perda não foi encontrada.", 404);
  if (error.code === "22023") return lossFail(requestId, "INVALID_STOCK_LOSS", "Confira produto, quantidade, motivo, observação e decisão.", 422);
  return lossFail(requestId, "INVENTORY_UNAVAILABLE", "Não foi possível processar a perda.", 503);
}

export async function mapLossContext(data: unknown, requestId: string, signPhoto: (path: string) => Promise<string | null>) {
  const record = data as Record<string, unknown> | null;
  const rows = Array.isArray(record?.reports) ? record.reports as Record<string, unknown>[] : [];
  const photoUrls = new Map<string, string | null>();
  await Promise.all(rows.map(async (row) => { if (typeof row.photo_path === "string") photoUrls.set(row.photo_path, await signPhoto(row.photo_path)); }));
  const options = Array.isArray(record?.options) ? record.options as Record<string, unknown>[] : [];
  return stockLossContextResponseSchema.safeParse({ data: {
    ownLocationId: record?.own_location_id ?? null, approvalThresholdQuantity: record?.approval_threshold_quantity ?? null, nextCursor: record?.next_cursor ?? null,
    options: options.map((row) => ({ productId: row.product_id, productName: row.product_name, productSku: row.product_sku, availableQuantity: row.available_quantity })),
    reports: rows.map((row) => ({ id: row.id, locationId: row.location_id, locationName: row.location_name, productId: row.product_id, productName: row.product_name, productSku: row.product_sku, quantity: row.quantity, reason: row.reason, observation: row.observation, photoPath: row.photo_path, photoUrl: typeof row.photo_path === "string" ? photoUrls.get(row.photo_path) ?? null : null, status: row.status, reportedBy: row.reported_by, decisionReason: row.decision_reason, movementId: row.movement_id, createdAt: row.created_at, decidedAt: row.decided_at })),
  }, request_id: requestId });
}

export const uuidPath = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
