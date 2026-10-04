import { idempotencyKeySchema, portalEventResponseSchema, transitionPortalEventRequestSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databasePortalEventSchema, eventDatabaseError, eventErrorResponse, toPortalEvent } from "@/lib/portal-events";

interface RouteContext { params: Promise<{ id: string }>; }

/** Publishes a draft or cancels an event with a reason. */
export async function POST(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = transitionPortalEventRequestSchema.safeParse(await request.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !key.success || !parsed.success) {
    return eventErrorResponse("INVALID_REQUEST", "Confira a ação sobre o evento.", requestId, 422);
  }
  try {
    await requirePermission("communications.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("transition_portal_event", {
      p_event_id: id, p_action: parsed.data.action, p_reason: parsed.data.action === "CANCELAR" ? parsed.data.reason : null,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return eventDatabaseError(error.message, requestId);
    const row = databasePortalEventSchema.safeParse(data);
    if (!row.success) return eventErrorResponse("EVENTS_UNAVAILABLE", "Eventos temporariamente indisponíveis.", requestId, 503);
    const covers = client.storage.from("event-covers");
    return NextResponse.json(portalEventResponseSchema.parse({
      data: toPortalEvent(row.data, (path) => covers.getPublicUrl(path).data.publicUrl), request_id: requestId,
    }), { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return eventErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return eventErrorResponse("EVENTS_UNAVAILABLE", "Eventos temporariamente indisponíveis.", requestId, 503);
  }
}
