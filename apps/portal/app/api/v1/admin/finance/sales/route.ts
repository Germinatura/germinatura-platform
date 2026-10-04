import { adminSalesQuerySchema, adminSalesResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { adminSalesErrorResponse, databaseAdminSaleSchema, toAdminSale } from "@/lib/admin-sales";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const databaseListSchema = z.object({ items: z.array(databaseAdminSaleSchema), next_cursor: z.uuid().nullable() });

/** Etapa 6: every sale for finance, filtered by status, channel, pending and São Paulo period. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("sales.read.all");
    const query = adminSalesQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return adminSalesErrorResponse("INVALID_SALES_QUERY", "Filtros de vendas inválidos.", requestId, 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_sales_admin", {
      p_status: query.data.status ?? null, p_channel: query.data.channel ?? null, p_pending: query.data.pending === "true",
      p_from: query.data.from ?? null, p_to: query.data.to ?? null, p_cursor: query.data.cursor ?? null, p_limit: 25,
    });
    if (error?.message.includes("INVALID_SALES")) return adminSalesErrorResponse("INVALID_SALES_QUERY", "Filtros de vendas inválidos.", requestId, 422);
    const rows = databaseListSchema.safeParse(data);
    if (error || !rows.success) return adminSalesErrorResponse("SALES_UNAVAILABLE", "Não foi possível consultar as vendas.", requestId, 503);
    const response = adminSalesResponseSchema.safeParse({
      data: rows.data.items.map(toAdminSale), nextCursor: rows.data.next_cursor, request_id: requestId,
    });
    if (!response.success) return adminSalesErrorResponse("SALES_UNAVAILABLE", "Dados de vendas inválidos.", requestId, 503);
    return NextResponse.json(response.data, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return adminSalesErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    }
    return adminSalesErrorResponse("SALES_UNAVAILABLE", "Não foi possível consultar as vendas.", requestId, 503);
  }
}
