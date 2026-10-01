import { createApiError, idempotencyKeySchema, portalEventResponseSchema, portalEventSchema, savePortalEventRequestSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

// Rows returned by private.portal_event_json.
export const databasePortalEventSchema = z.object({
  id: z.uuid(), kind: z.string(), title: z.string(), description: z.string(), starts_at: z.string(), ends_at: z.string().nullable(),
  location: z.string().nullable(), external_url: z.string().nullable(), cta_label: z.string().nullable(), cta_url: z.string().nullable(),
  cover_path: z.string().nullable(), cover_alt: z.string().nullable(), status: z.string(), over: z.boolean(),
  published_at: z.string().nullable(), cancelled_at: z.string().nullable(), cancel_reason: z.string().nullable(),
  products: z.array(z.object({ id: z.uuid(), name: z.string() })),
  promotions: z.array(z.object({ id: z.uuid(), name: z.string(), valid_from: z.string(), valid_to: z.string().nullable() })),
  sellers: z.array(z.object({ id: z.uuid(), name: z.string() })),
  revision: z.number().int().nullable(), updated_at: z.string().nullable(),
});
export type DatabasePortalEvent = z.infer<typeof databasePortalEventSchema>;

/** Maps an event row; the cover path becomes the public URL of the event-covers bucket. */
export function toPortalEvent(value: DatabasePortalEvent, coverUrl: (path: string) => string) {
  return portalEventSchema.parse({
    id: value.id, kind: value.kind, title: value.title, description: value.description, startsAt: value.starts_at, endsAt: value.ends_at,
    location: value.location, externalUrl: value.external_url, ctaLabel: value.cta_label, ctaUrl: value.cta_url,
    coverUrl: value.cover_path ? coverUrl(value.cover_path) : null, coverAlt: value.cover_alt, status: value.status, over: value.over,
    publishedAt: value.published_at, cancelledAt: value.cancelled_at, cancelReason: value.cancel_reason,
    products: value.products,
    promotions: value.promotions.map((promotion) => ({ id: promotion.id, name: promotion.name, validFrom: promotion.valid_from, validTo: promotion.valid_to })),
    sellers: value.sellers, revision: value.revision, updatedAt: value.updated_at,
  });
}

export function eventErrorResponse(code: string, message: string, requestId: string, status: number) {
  return NextResponse.json(createApiError(code, message, requestId), {
    status, headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}

/** Maps database errors of the event commands to API responses. */
export function eventDatabaseError(message: string, requestId: string) {
  const conflicts: Record<string, string> = {
    PORTAL_EVENT_REVISION_CONFLICT: "O evento mudou em outra sessão. Atualize a página.",
    PORTAL_EVENT_CANCELLED: "Evento cancelado não pode ser alterado.",
    PORTAL_EVENT_NOT_DRAFT: "Só um rascunho pode ser publicado.",
    PORTAL_EVENT_ALREADY_OVER: "Este evento já terminou e não pode ser publicado.",
    PORTAL_EVENT_COVER_MISSING: "A imagem não foi encontrada. Envie de novo.",
    IDEMPOTENCY_CONFLICT: "A chave já foi usada com outro conteúdo.",
    IDEMPOTENCY_IN_PROGRESS: "A operação já está em processamento.",
  };
  const code = Object.keys(conflicts).find((key) => message.includes(key));
  if (code) return eventErrorResponse(code, conflicts[code], requestId, 409);
  if (message.includes("PORTAL_EVENT_NOT_FOUND")) return eventErrorResponse("NOT_FOUND", "Evento não encontrado.", requestId, 404);
  if (message.includes("INVALID_PORTAL_EVENT_LINKS")) {
    return eventErrorResponse("INVALID_PORTAL_EVENT_LINKS", "Produtos, promoções ou vendedores escolhidos não estão mais disponíveis.", requestId, 422);
  }
  if (message.includes("_REQUIRED")) return eventErrorResponse("FORBIDDEN", "Operação não autorizada.", requestId, 403);
  if (message.includes("INVALID_")) return eventErrorResponse("INVALID_REQUEST", "Confira os dados do evento.", requestId, 422);
  return eventErrorResponse("EVENTS_UNAVAILABLE", "Eventos temporariamente indisponíveis.", requestId, 503);
}

/** Creates a draft (no id) or edits an event at the expected revision. */
export async function saveEvent(request: Request, eventId: string | null) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = savePortalEventRequestSchema.safeParse(await request.json().catch(() => null));
  if (!key.success || !parsed.success || (eventId !== null && parsed.data.expectedRevision === null)) {
    return eventErrorResponse("INVALID_REQUEST", "Confira os dados do evento.", requestId, 422);
  }
  const value = parsed.data;
  try {
    await requirePermission("communications.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("save_portal_event", {
      p_event_id: eventId, p_expected_revision: eventId === null ? null : value.expectedRevision, p_kind: value.kind,
      p_title: value.title, p_description: value.description, p_starts_at: value.startsAt, p_ends_at: value.endsAt,
      p_location: value.location, p_external_url: value.externalUrl, p_cta_label: value.ctaLabel, p_cta_url: value.ctaUrl,
      p_product_ids: value.productIds, p_promotion_ids: value.promotionIds, p_seller_ids: value.sellerIds,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return eventDatabaseError(error.message, requestId);
    const row = databasePortalEventSchema.safeParse(data);
    if (!row.success) return eventErrorResponse("EVENTS_UNAVAILABLE", "Eventos temporariamente indisponíveis.", requestId, 503);
    const covers = client.storage.from("event-covers");
    return NextResponse.json(portalEventResponseSchema.parse({
      data: toPortalEvent(row.data, (path) => covers.getPublicUrl(path).data.publicUrl), request_id: requestId,
    }), { status: eventId === null ? 201 : 200, headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return eventErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return eventErrorResponse("EVENTS_UNAVAILABLE", "Eventos temporariamente indisponíveis.", requestId, 503);
  }
}
