import { idempotencyKeySchema, portalEventCoverQuerySchema, portalEventResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { CATALOG_IMAGE_MAX_BYTES, detectCatalogImageFile, storageConflict } from "@/lib/catalog-image-file";
import { databasePortalEventSchema, eventDatabaseError, eventErrorResponse, toPortalEvent } from "@/lib/portal-events";

interface RouteContext { params: Promise<{ id: string }>; }

/** Uploads the cover (JPG, PNG or WebP up to 5 MB, checked by content) to a fresh path and records it. */
export async function POST(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const query = portalEventCoverQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!z.uuid().safeParse(id).success || !key.success || !query.success) {
    return eventErrorResponse("INVALID_REQUEST", "Envie a imagem com a descrição.", requestId, 422);
  }
  try {
    await requirePermission("communications.manage");
    const bytes = new Uint8Array(await request.arrayBuffer().catch(() => new ArrayBuffer(0)));
    const type = bytes.byteLength > 0 && bytes.byteLength <= CATALOG_IMAGE_MAX_BYTES ? detectCatalogImageFile(bytes) : null;
    if (!type) return eventErrorResponse("INVALID_EVENT_COVER", "Envie uma imagem JPG, PNG ou WebP de até 5 MB.", requestId, 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const objectId = crypto.randomUUID();
    const objectPath = `events/${id}/${objectId}.${type.extension}`;
    const uploaded = await client.storage.from("event-covers").upload(objectPath, bytes, {
      cacheControl: "31536000", contentType: type.mimeType, upsert: false,
    });
    if (uploaded.error && !storageConflict(uploaded.error)) {
      return eventErrorResponse("COVER_STORAGE_UNAVAILABLE", "Não foi possível enviar a imagem. Tente novamente.", requestId, 503);
    }
    const { data, error } = await client.rpc("set_portal_event_cover", {
      p_event_id: id, p_cover_path: objectPath, p_cover_alt: query.data.alt, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
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
