import { mySalesQuerySchema, mySalesResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { shiftErrorResponse } from "@/lib/seller-shift";

const databaseSalesSchema = z.object({
  items: z.array(z.object({
    sale_id: z.uuid(),
    status: z.enum(["AWAITING_PAYMENT", "CONFIRMED", "CANCELLED"]),
    created_at: z.string(),
    location_id: z.uuid(),
    original_total_cents: z.number().int(),
    discount_total_cents: z.number().int(),
    total_cents: z.number().int(),
    pending_reason: z.enum(["AWAITING_PAYMENT", "RECONCILIATION_PENDING"]).nullable(),
    reservation_expires_at: z.string().nullable(),
    payment: z.object({
      attempt_id: z.uuid(),
      status: z.string(),
      integration_channel: z.string().nullable(),
      confirmation_source: z.string().nullable(),
      confirmed_at: z.string().nullable(),
    }).nullable(),
    items: z.array(z.object({ product_name: z.string(), quantity: z.number().int(), total_cents: z.number().int() })).nullable(),
  })),
  next_cursor: z.uuid().nullable(),
  pending_count: z.number().int(),
});

/** Spec 6.10: the seller's own PDV sales ("Minhas vendas"), pending ones highlighted. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("sales.create");
    const query = mySalesQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return shiftErrorResponse("INVALID_SALES_QUERY", "Consulta de vendas inválida.", requestId, 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_my_sales", {
      p_filter: query.data.filter ?? null, p_cursor: query.data.cursor ?? null, p_limit: 20,
    });
    if (error?.message.includes("INVALID_SALES_CURSOR")) return shiftErrorResponse("INVALID_SALES_CURSOR", "Página de vendas inválida.", requestId, 422);
    if (error?.message.includes("SELLER_REQUIRED")) return shiftErrorResponse("FORBIDDEN", "Operação não autorizada.", requestId, 403);
    const rows = databaseSalesSchema.safeParse(data);
    if (error || !rows.success) return shiftErrorResponse("SALES_UNAVAILABLE", "Não foi possível consultar suas vendas.", requestId, 503);
    const response = mySalesResponseSchema.safeParse({
      data: rows.data.items.map((sale) => ({
        saleId: sale.sale_id, status: sale.status, createdAt: sale.created_at, locationId: sale.location_id,
        originalTotalCents: sale.original_total_cents, discountTotalCents: sale.discount_total_cents, totalCents: sale.total_cents,
        pendingReason: sale.pending_reason, reservationExpiresAt: sale.reservation_expires_at,
        payment: sale.payment && {
          attemptId: sale.payment.attempt_id, status: sale.payment.status, integrationChannel: sale.payment.integration_channel,
          confirmationSource: sale.payment.confirmation_source, confirmedAt: sale.payment.confirmed_at,
        },
        items: (sale.items ?? []).map((item) => ({ productName: item.product_name, quantity: item.quantity, totalCents: item.total_cents })),
      })),
      nextCursor: rows.data.next_cursor,
      pendingCount: rows.data.pending_count,
      request_id: requestId,
    });
    if (!response.success) return shiftErrorResponse("SALES_UNAVAILABLE", "Dados de vendas inválidos.", requestId, 503);
    return NextResponse.json(response.data, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return shiftErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    }
    return shiftErrorResponse("SALES_UNAVAILABLE", "Não foi possível consultar suas vendas.", requestId, 503);
  }
}
