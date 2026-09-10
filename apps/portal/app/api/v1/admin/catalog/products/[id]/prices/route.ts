import { catalogProductPriceHistoryQuerySchema, catalogProductPriceHistoryResponseSchema, createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

interface RouteContext { params: Promise<{ id: string }>; }

const priceRowsSchema = z.array(z.object({
  id: z.uuid(), product_id: z.uuid(), amount_cents: z.number().int().nonnegative(),
  valid_from: z.iso.datetime({ offset: true }), valid_to: z.iso.datetime({ offset: true }).nullable(),
  created_by: z.uuid().nullable(), created_at: z.iso.datetime({ offset: true }),
}));

export async function GET(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const fail = (code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers });
  try {
    await requirePermission("catalog.manage");
    const { id } = await context.params;
    if (!z.uuid().safeParse(id).success) return fail("PRODUCT_NOT_FOUND", "Produto não encontrado.", 404);
    const url = new URL(request.url);
    const parsed = catalogProductPriceHistoryQuerySchema.safeParse({ cursor: url.searchParams.get("cursor") ?? undefined, limit: url.searchParams.get("limit") ?? undefined });
    if (!parsed.success) return fail("INVALID_QUERY", "Consulta de histórico inválida.", 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data: product, error: productError } = await client.from("products").select("id").eq("id", id).maybeSingle();
    if (productError) return fail("CATALOG_UNAVAILABLE", "Não foi possível consultar o histórico. Tente novamente.", 503);
    if (!product) return fail("PRODUCT_NOT_FOUND", "Produto não encontrado.", 404);
    let query = client.from("product_prices")
      .select("id,product_id,amount_cents,valid_from,valid_to,created_by,created_at")
      .eq("product_id", id).order("valid_from", { ascending: false }).limit(parsed.data.limit + 1);
    if (parsed.data.cursor) query = query.lt("valid_from", parsed.data.cursor);
    const { data, error } = await query;
    if (error) return fail("CATALOG_UNAVAILABLE", "Não foi possível consultar o histórico. Tente novamente.", 503);
    const rows = priceRowsSchema.safeParse(data);
    if (!rows.success) return fail("CATALOG_UNAVAILABLE", "Não foi possível confirmar o histórico. Tente novamente.", 503);
    const page = rows.data.slice(0, parsed.data.limit);
    const payload = catalogProductPriceHistoryResponseSchema.parse({
      data: page.map((price) => ({
        id: price.id, productId: price.product_id, amountCents: price.amount_cents,
        validFrom: price.valid_from, validTo: price.valid_to, createdBy: price.created_by, createdAt: price.created_at,
      })),
      nextCursor: rows.data.length > parsed.data.limit ? page.at(-1)?.valid_from ?? null : null,
      request_id: requestId,
    });
    return NextResponse.json(payload, { headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("CATALOG_UNAVAILABLE", "Não foi possível consultar o histórico. Tente novamente.", 503);
  }
}
