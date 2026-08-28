import {
  createApiError,
  publicCatalogProductsQuerySchema,
  publicCatalogProductsResponseSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createPublicSupabaseClient } from "@/lib/supabase/public";

const databaseProductSchema = z.object({
  id: z.uuid(),
  sku: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sellable_pdv: z.boolean(),
  reservable: z.boolean(),
  category: z.object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
  }),
  prices: z.array(z.object({ amount_cents: z.number().int().nonnegative() })).length(1),
});

function errorResponse(code: string, message: string, requestId: string, status: number, details?: unknown) {
  return NextResponse.json(createApiError(code, message, requestId, details), {
    status,
    headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}

export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  const url = new URL(request.url);
  const parsedQuery = publicCatalogProductsQuerySchema.safeParse({
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });

  if (!parsedQuery.success) {
    return errorResponse("INVALID_QUERY", "Consulta de catálogo inválida", requestId, 422, parsedQuery.error.issues);
  }

  const { cursor, limit } = parsedQuery.data;
  const supabase = createPublicSupabaseClient();
  let query = supabase
    .from("products")
    .select(`
      id,
      sku,
      slug,
      name,
      description,
      sellable_pdv,
      reservable,
      category:categories!inner(id, slug, name),
      prices:product_prices!inner(amount_cents)
    `)
    .eq("active", true)
    .eq("published", true)
    .order("id", { ascending: true })
    .limit(limit + 1);

  if (cursor) query = query.gt("id", cursor);

  const { data, error } = await query;
  if (error) return errorResponse("CATALOG_UNAVAILABLE", "Catálogo temporariamente indisponível", requestId, 503);

  const parsedRows = z.array(databaseProductSchema).safeParse(data);
  if (!parsedRows.success) {
    return errorResponse("CATALOG_INVALID_DATA", "Catálogo temporariamente indisponível", requestId, 503);
  }

  const hasMore = parsedRows.data.length > limit;
  const rows = parsedRows.data.slice(0, limit);
  const response = publicCatalogProductsResponseSchema.parse({
    data: rows.map((row) => ({
      id: row.id,
      sku: row.sku,
      slug: row.slug,
      name: row.name,
      description: row.description,
      category: row.category,
      price: { amountCents: row.prices[0].amount_cents, currency: "BRL" },
      sellablePdv: row.sellable_pdv,
      reservable: row.reservable,
    })),
    nextCursor: hasMore ? rows.at(-1)?.id ?? null : null,
    request_id: requestId,
  });

  return NextResponse.json(response, {
    headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}
