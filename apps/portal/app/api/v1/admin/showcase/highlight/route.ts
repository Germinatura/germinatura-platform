import { idempotencyKeySchema, portalHighlightResponseSchema, savePortalHighlightRequestSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { eventDatabaseError, eventErrorResponse } from "@/lib/portal-events";
import { databaseHighlightSchema, toHighlight } from "@/lib/portal-showcase";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });

/** The highlight currently configured, even when turned off. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("communications.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("get_portal_highlight_admin");
    if (error) return eventDatabaseError(error.message, requestId);
    const row = z.object({ highlight: databaseHighlightSchema.nullable() }).safeParse(data);
    if (!row.success) return eventErrorResponse("SHOWCASE_UNAVAILABLE", "Destaque temporariamente indisponível.", requestId, 503);
    return NextResponse.json(portalHighlightResponseSchema.parse({
      data: row.data.highlight ? toHighlight(row.data.highlight) : null, request_id: requestId,
    }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return eventErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return eventErrorResponse("SHOWCASE_UNAVAILABLE", "Destaque temporariamente indisponível.", requestId, 503);
  }
}

/** Saves a new version of the highlight; the previous ones stay in the history. */
export async function PUT(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = savePortalHighlightRequestSchema.safeParse(await request.json().catch(() => null));
  if (!key.success || !parsed.success) return eventErrorResponse("INVALID_REQUEST", "Confira o destaque.", requestId, 422);
  try {
    await requirePermission("communications.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("save_portal_highlight", {
      p_title: parsed.data.title, p_message: parsed.data.message, p_cta_label: parsed.data.ctaLabel, p_cta_url: parsed.data.ctaUrl,
      p_active: parsed.data.active, p_visible_until: parsed.data.visibleUntil, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return eventDatabaseError(error.message, requestId);
    const row = databaseHighlightSchema.safeParse(data);
    if (!row.success) return eventErrorResponse("SHOWCASE_UNAVAILABLE", "Destaque temporariamente indisponível.", requestId, 503);
    return NextResponse.json(portalHighlightResponseSchema.parse({ data: toHighlight(row.data), request_id: requestId }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return eventErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return eventErrorResponse("SHOWCASE_UNAVAILABLE", "Destaque temporariamente indisponível.", requestId, 503);
  }
}
