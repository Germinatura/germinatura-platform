import { portalEventResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { databasePortalEventSchema, eventDatabaseError, eventErrorResponse, toPortalEvent } from "@/lib/portal-events";

interface RouteContext { params: Promise<{ id: string }>; }

/** One published event; drafts are visible only to the communications team. */
export async function GET(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return eventErrorResponse("NOT_FOUND", "Evento não encontrado.", requestId, 404);
  try {
    await requirePermission("portal.access");
    const client = await createAuthenticatedSupabaseClient(request);
    if (!await isFeatureEnabled("events", client)) return eventErrorResponse("NOT_FOUND", "Evento não encontrado.", requestId, 404);
    const { data, error } = await client.rpc("get_portal_event", { p_event_id: id });
    if (error) return eventDatabaseError(error.message, requestId);
    const row = databasePortalEventSchema.safeParse(data);
    if (!row.success) return eventErrorResponse("EVENTS_UNAVAILABLE", "Evento temporariamente indisponível.", requestId, 503);
    const covers = client.storage.from("event-covers");
    return NextResponse.json(portalEventResponseSchema.parse({
      data: toPortalEvent(row.data, (path) => covers.getPublicUrl(path).data.publicUrl), request_id: requestId,
    }), { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return eventErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return eventErrorResponse("EVENTS_UNAVAILABLE", "Evento temporariamente indisponível.", requestId, 503);
  }
}
