import { portalEventsQuerySchema, portalEventsResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databasePortalEventSchema, eventDatabaseError, eventErrorResponse, toPortalEvent } from "@/lib/portal-events";

/** Spec 4.5: published events and campaigns, upcoming in date order or the archive of past ones. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  const query = portalEventsQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return eventErrorResponse("INVALID_REQUEST", "Consulta inválida.", requestId, 422);
  try {
    await requirePermission("portal.access");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_portal_events", { p_archive: query.data.archive === "true", p_limit: 20 });
    if (error) return eventDatabaseError(error.message, requestId);
    const rows = z.object({ items: z.array(databasePortalEventSchema) }).safeParse(data);
    if (!rows.success) return eventErrorResponse("EVENTS_UNAVAILABLE", "Eventos temporariamente indisponíveis.", requestId, 503);
    const covers = client.storage.from("event-covers");
    return NextResponse.json(portalEventsResponseSchema.parse({
      data: rows.data.items.map((row) => toPortalEvent(row, (path) => covers.getPublicUrl(path).data.publicUrl)), request_id: requestId,
    }), { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return eventErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return eventErrorResponse("EVENTS_UNAVAILABLE", "Eventos temporariamente indisponíveis.", requestId, 503);
  }
}
