import { portalEventsAdminResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databasePortalEventSchema, eventDatabaseError, eventErrorResponse, saveEvent, toPortalEvent } from "@/lib/portal-events";

const option = z.object({ id: z.uuid(), name: z.string() });

/** Spec 4.5: every event, drafts included, with the sellers and promotions that can be linked. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("communications.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_portal_events_admin", { p_limit: 100 });
    if (error) return eventDatabaseError(error.message, requestId);
    const rows = z.object({ items: z.array(databasePortalEventSchema), sellers: z.array(option), promotions: z.array(option) }).safeParse(data);
    if (!rows.success) return eventErrorResponse("EVENTS_UNAVAILABLE", "Eventos temporariamente indisponíveis.", requestId, 503);
    const covers = client.storage.from("event-covers");
    return NextResponse.json(portalEventsAdminResponseSchema.parse({
      data: rows.data.items.map((row) => toPortalEvent(row, (path) => covers.getPublicUrl(path).data.publicUrl)),
      sellers: rows.data.sellers, promotions: rows.data.promotions, request_id: requestId,
    }), { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return eventErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return eventErrorResponse("EVENTS_UNAVAILABLE", "Eventos temporariamente indisponíveis.", requestId, 503);
  }
}

/** Creates a draft event or campaign. */
export async function POST(request: Request) {
  return saveEvent(request, null);
}
