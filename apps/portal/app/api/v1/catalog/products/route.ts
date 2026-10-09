import {
  createApiError,
  publicCatalogProductsQuerySchema,
  publicCatalogProductsResponseSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { resolvePublicCohort } from "@/lib/public-cohort";
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
  images: z.array(z.object({ id: z.uuid(), object_path: z.string(), alt_text: z.string(), sort_order: z.number().int() })),
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
  // ADR 0011: a signed-in person sees the public catalog of the cohort in context (validated by the proxy). A visitor
  // sees the default cohort's, or the ACTIVE cohort named by its public slug (?turma=), resolved here; an unknown or
  // inactive slug is 404, never the default cohort. The filters below repeat the public read rules.
  const slug = url.searchParams.get("turma");
  let supabase;
  let resolvedCohort: string | null = null;
  if (await getSession()) {
    supabase = await createAuthenticatedSupabaseClient(request);
  } else if (slug !== null) {
    const cohort = await resolvePublicCohort(slug);
    if (!cohort) return errorResponse("COHORT_NOT_FOUND", "Turma não encontrada ou indisponível.", requestId, 404);
    supabase = createPublicSupabaseClient(cohort.id);
    resolvedCohort = cohort.id;
  } else {
    supabase = createPublicSupabaseClient();
  }
  const now = new Date().toISOString();
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
      prices:product_prices!inner(amount_cents),
      images:product_images(id, object_path, alt_text, sort_order)
    `)
    .eq("active", true)
    .eq("published", true)
    .eq("category.active", true)
    .lte("prices.valid_from", now)
    .or(`valid_to.is.null,valid_to.gt."${now}"`, { referencedTable: "prices" })
    .eq("images.status", "ACTIVE")
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
  const storage = supabase.storage.from("product-images");
  // A failed availability lookup only hides the flag; it never breaks the catalog.
  const availability = rows.length > 0
    ? await supabase.rpc("portal_availability", { p_product_ids: rows.map((row) => row.id) })
    : { data: [], error: null };
  const availableById = new Map(availability.error ? [] : z.array(z.object({ product_id: z.uuid(), available: z.boolean() }))
    .catch([]).parse(availability.data).map((item) => [item.product_id, item.available] as const));
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
      portalAvailable: availableById.get(row.id),
      images: row.images.sort((left, right) => left.sort_order - right.sort_order || left.id.localeCompare(right.id)).map((image) => ({
        id: image.id, altText: image.alt_text, sortOrder: image.sort_order,
        publicUrl: storage.getPublicUrl(image.object_path).data.publicUrl,
      })),
    })),
    nextCursor: hasMore ? rows.at(-1)?.id ?? null : null,
    request_id: requestId,
  });

  // A catalog resolved from a slug names its cohort, so the PDV offline copy is stored only under that cohort.
  return NextResponse.json(response, {
    headers: { "Cache-Control": "no-store", "x-request-id": requestId, ...(resolvedCohort ? { "x-germinatura-cohort": resolvedCohort } : {}) },
  });
}
