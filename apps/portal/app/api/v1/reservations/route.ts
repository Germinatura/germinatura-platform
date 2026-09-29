import {
  commercialReservationCreateRequestSchema,
  commercialReservationCreateResponseSchema,
  createApiError,
  idempotencyKeySchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requireSession } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { publicQuote, storedQuoteSchema } from "@/lib/promotion-snapshot";

const resultSchema = z.object({
  reservation_id: z.uuid(),
  status: z.literal("ACTIVE"),
  location_id: z.uuid(),
  quote: storedQuoteSchema,
  stock_reservation: z.object({
    reservation_id: z.uuid(), status: z.literal("ACTIVE"), expires_at: z.string(),
    reservation_movement_id: z.uuid(),
  }),
  correlation_id: z.uuid(),
});

function response(code: string, message: string, requestId: string, status: number, details?: unknown) {
  return NextResponse.json(createApiError(code, message, requestId, details), {
    status, headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!key.success) return response("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key inválida ou ausente", requestId, 422);
  let body: unknown;
  try { body = await request.json(); } catch { return response("INVALID_BODY", "Corpo JSON inválido", requestId, 422); }
  const parsed = commercialReservationCreateRequestSchema.safeParse(body);
  if (!parsed.success) return response("INVALID_RESERVATION", "Reserva inválida", requestId, 422, parsed.error.issues);
  try { await requireSession(); } catch (error) {
    if (error instanceof AuthorizationError) return response(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return response("RESERVATION_UNAVAILABLE", "Reserva temporariamente indisponível", requestId, 503);
  }
  const correlationId = crypto.randomUUID();
  const supabase = await createAuthenticatedSupabaseClient(request);
  let locationId = parsed.data.locationId;
  if (!locationId) {
    const location = await supabase.rpc("default_reservation_location");
    if (location.error || typeof location.data !== "string") {
      return response("RESERVATION_UNAVAILABLE", "Reservas temporariamente indisponíveis", requestId, 503);
    }
    locationId = location.data;
  }
  const { data, error } = await supabase.rpc("create_commercial_reservation", {
    p_location_id: locationId,
    p_items: parsed.data.items.map((item) => ({ product_id: item.productId, quantity: item.quantity })),
    p_idempotency_key: key.data, p_correlation_id: correlationId,
    p_coupon_code: parsed.data.couponCode ?? null,
  });
  if (error) {
    if (error.message.includes("IDEMPOTENCY_CONFLICT")) return response("IDEMPOTENCY_CONFLICT", "A chave já foi usada com outro conteúdo", requestId, 409);
    if (error.message.includes("STOCK_CONFLICT")) return response("STOCK_CONFLICT", "Estoque insuficiente", requestId, 409);
    if (error.message.includes("FEATURE_DISABLED")) return response("FEATURE_DISABLED", "Reservas desativadas no momento", requestId, 409);
    if (error.message.includes("INVALID_")) return response("INVALID_RESERVATION", "Confira os itens e o cupom da reserva", requestId, 422);
    if (error.message.includes("FORBIDDEN")) return response("FORBIDDEN", "Reserva não autorizada", requestId, 403);
    return response("RESERVATION_UNAVAILABLE", "Reserva temporariamente indisponível", requestId, 503);
  }
  // GROW-001: a reservation made after a tracked link is attributed to that campaign (best effort).
  const origin = request.headers.get("cookie")?.match(/(?:^|;\s*)germinatura_origin=([a-z0-9]{8})(?:;|$)/)?.[1];
  const createdId = typeof data === "object" && data !== null && "reservation_id" in data ? String(data.reservation_id) : null;
  if (origin && createdId) await supabase.rpc("attribute_reservation", { p_reservation_id: createdId, p_code: origin });
  const result = resultSchema.safeParse(data);
  if (!result.success) return response("RESERVATION_INVALID_DATA", "Reserva temporariamente indisponível", requestId, 503);
  const value = result.data;
  const payload = commercialReservationCreateResponseSchema.parse({
    data: {
      reservationId: value.reservation_id, status: value.status, locationId: value.location_id,
      quote: publicQuote(value.quote, "PORTAL"),
      stockReservation: {
        reservationId: value.stock_reservation.reservation_id, status: value.stock_reservation.status,
        expiresAt: value.stock_reservation.expires_at,
        reservationMovementId: value.stock_reservation.reservation_movement_id,
      }, correlationId: value.correlation_id,
    }, request_id: requestId,
  });
  return NextResponse.json(payload, { status: 201, headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
}
