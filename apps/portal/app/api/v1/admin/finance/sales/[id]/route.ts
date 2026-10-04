import { adminSaleDetailResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { adminSalesErrorResponse, databaseAdminSaleDetailSchema, toAdminSaleDetail } from "@/lib/admin-sales";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

interface RouteContext { params: Promise<{ id: string }>; }

/** Etapa 6: one sale with payment, ledger, drawer movements, history and reversal eligibility. */
export async function GET(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return adminSalesErrorResponse("INVALID_SALE", "Venda inválida.", requestId, 422);
  try {
    await requirePermission("sales.read.all");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("get_sale_admin", { p_sale_id: id });
    if (error?.message.includes("SALE_NOT_FOUND")) return adminSalesErrorResponse("SALE_NOT_FOUND", "Venda não encontrada.", requestId, 404);
    const row = databaseAdminSaleDetailSchema.safeParse(data);
    if (error || !row.success) return adminSalesErrorResponse("SALES_UNAVAILABLE", "Não foi possível consultar a venda.", requestId, 503);
    const response = adminSaleDetailResponseSchema.safeParse({ data: toAdminSaleDetail(row.data), request_id: requestId });
    if (!response.success) return adminSalesErrorResponse("SALES_UNAVAILABLE", "Dados da venda inválidos.", requestId, 503);
    return NextResponse.json(response.data, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return adminSalesErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    }
    return adminSalesErrorResponse("SALES_UNAVAILABLE", "Não foi possível consultar a venda.", requestId, 503);
  }
}
