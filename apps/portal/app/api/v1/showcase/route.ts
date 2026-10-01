import { portalShowcaseResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { databasePortalEventSchema, eventDatabaseError, eventErrorResponse, toPortalEvent } from "@/lib/portal-events";
import { databaseHighlightSchema, toHighlight } from "@/lib/portal-showcase";

const databaseShowcaseSchema = z.object({
  highlight: databaseHighlightSchema.nullable(),
  new_products: z.array(z.object({ id: z.uuid(), name: z.string(), category: z.string(), image_path: z.string().nullable(), image_alt: z.string().nullable() })),
  promotions: z.array(z.object({ id: z.uuid(), name: z.string(), description: z.string().nullable(), valid_to: z.string().nullable() })),
  events: z.array(databasePortalEventSchema),
  raffles: z.array(z.object({ id: z.uuid(), name: z.string(), ends_at: z.string(), number_count: z.number().int(), available_count: z.number().int() })),
});

/** Spec 4.1: highlight, new products, live promotions, upcoming events and raffles on sale for the Início page. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("portal.access");
    const client = await createAuthenticatedSupabaseClient(request);
    const [{ data, error }, eventsEnabled] = await Promise.all([client.rpc("get_portal_showcase"), isFeatureEnabled("events", client)]);
    if (error) return eventDatabaseError(error.message, requestId);
    const row = databaseShowcaseSchema.safeParse(data);
    if (!row.success) return eventErrorResponse("SHOWCASE_UNAVAILABLE", "Vitrine temporariamente indisponível.", requestId, 503);
    const images = client.storage.from("product-images");
    const covers = client.storage.from("event-covers");
    return NextResponse.json(portalShowcaseResponseSchema.parse({
      data: {
        highlight: row.data.highlight ? toHighlight(row.data.highlight) : null,
        newProducts: row.data.new_products.map((product) => ({
          id: product.id, name: product.name, category: product.category,
          imageUrl: product.image_path ? images.getPublicUrl(product.image_path).data.publicUrl : null, imageAlt: product.image_alt,
        })),
        promotions: row.data.promotions.map((promotion) => ({ id: promotion.id, name: promotion.name, description: promotion.description, validTo: promotion.valid_to })),
        events: (eventsEnabled ? row.data.events : []).map((event) => toPortalEvent(event, (path) => covers.getPublicUrl(path).data.publicUrl)),
        raffles: row.data.raffles.map((raffle) => ({
          id: raffle.id, name: raffle.name, endsAt: raffle.ends_at, numberCount: raffle.number_count, availableCount: raffle.available_count,
        })),
      },
      request_id: requestId,
    }), { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return eventErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return eventErrorResponse("SHOWCASE_UNAVAILABLE", "Vitrine temporariamente indisponível.", requestId, 503);
  }
}
