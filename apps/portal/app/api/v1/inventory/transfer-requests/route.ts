import {
  createApiError, idempotencyKeySchema, requestSellerStockTransferSchema,
  sellerStockTransferContextResponseSchema, sellerStockTransferMutationResponseSchema, sellerStockTransferQuerySchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const responseHeaders = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });
const fail = (requestId: string, code: string, message: string, status: number) => NextResponse.json(
  createApiError(code, message, requestId), { status, headers: responseHeaders(requestId) },
);

function mapRequest(row: Record<string, unknown>) {
  return {
    id: row.id, fromLocationId: row.from_location_id, fromLocationName: row.from_location_name,
    toLocationId: row.to_location_id, toLocationName: row.to_location_name,
    productId: row.product_id, productName: row.product_name, productSku: row.product_sku,
    quantity: row.quantity, status: row.status, requestedBy: row.requested_by,
    requestReason: row.request_reason, decisionReason: row.decision_reason,
    movementId: row.movement_id, createdAt: row.created_at, decidedAt: row.decided_at,
  };
}

function transferError(requestId: string, error: { code?: string; message: string }) {
  if (error.code === "42501") return fail(requestId, "FORBIDDEN", "Permissão insuficiente.", 403);
  if (error.message === "STOCK_CONFLICT") return fail(requestId, "STOCK_CONFLICT", "O saldo disponível mudou. Atualize e tente novamente.", 409);
  if (["IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_IN_PROGRESS", "TRANSFER_REQUEST_ALREADY_RESOLVED"].includes(error.message)) {
    return fail(requestId, error.message, "Esta solicitação já foi usada, resolvida ou ainda está em processamento.", 409);
  }
  if (["PRODUCT_NOT_FOUND", "TRANSFER_REQUEST_NOT_FOUND", "SELLER_LOCATION_NOT_FOUND"].includes(error.message)) {
    return fail(requestId, error.message, "Produto, localização ou solicitação não foi encontrada.", 404);
  }
  if (error.code === "22023" || error.message === "INVALID_TRANSFER_SOURCE") {
    return fail(requestId, "INVALID_SELLER_TRANSFER", "Confira origem, produto, quantidade e motivo.", 422);
  }
  return fail(requestId, "INVENTORY_UNAVAILABLE", "Não foi possível processar a transferência. Tente novamente.", 503);
}

export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("inventory.transfer.own");
    const parsed = sellerStockTransferQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return fail(requestId, "INVALID_TRANSFER_QUERY", "Consulta de transferências inválida.", 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("get_my_seller_stock_transfers", { p_cursor: parsed.data.cursor ?? null, p_limit: parsed.data.limit });
    if (error) return transferError(requestId, error);
    const record = data as Record<string, unknown> | null;
    const options = Array.isArray(record?.options) ? record.options : [];
    const requests = Array.isArray(record?.requests) ? record.requests : [];
    const result = sellerStockTransferContextResponseSchema.safeParse({
      data: {
        ownLocationId: record?.own_location_id ?? null,
        nextCursor: record?.next_cursor ?? null,
        options: options.map((value) => {
          const row = value as Record<string, unknown>;
          return {
            fromLocationId: row.from_location_id, fromLocationName: row.from_location_name,
            productId: row.product_id, productName: row.product_name, productSku: row.product_sku,
            availableQuantity: row.available_quantity,
          };
        }),
        requests: requests.map((value) => mapRequest(value as Record<string, unknown>)),
      },
      request_id: requestId,
    });
    if (!result.success) return fail(requestId, "INVENTORY_UNAVAILABLE", "A consulta de transferências retornou dados inválidos.", 503);
    return NextResponse.json(result.data, { headers: responseHeaders(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(requestId, error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail(requestId, "INVENTORY_UNAVAILABLE", "Não foi possível carregar as transferências.", 503);
  }
}

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("inventory.transfer.own");
    const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    const parsed = requestSellerStockTransferSchema.safeParse(await request.json().catch(() => null));
    if (!key.success || !parsed.success) return fail(requestId, "INVALID_SELLER_TRANSFER", "Confira origem, produto, quantidade e motivo.", 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const correlationId = crypto.randomUUID();
    const { data, error } = await client.rpc("request_seller_stock_transfer", {
      p_from_location_id: parsed.data.fromLocationId, p_product_id: parsed.data.productId,
      p_quantity: parsed.data.quantity, p_reason: parsed.data.reason,
      p_idempotency_key: key.data, p_correlation_id: correlationId,
    });
    if (error) return transferError(requestId, error);
    const result = sellerStockTransferMutationResponseSchema.safeParse({
      data: { requestId: data?.request_id, status: data?.status, correlationId: data?.correlation_id },
      request_id: requestId,
    });
    if (!result.success) return fail(requestId, "INVENTORY_UNAVAILABLE", "Não foi possível confirmar a solicitação.", 503);
    return NextResponse.json(result.data, { status: 201, headers: responseHeaders(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(requestId, error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail(requestId, "INVENTORY_UNAVAILABLE", "Não foi possível solicitar a transferência.", 503);
  }
}
