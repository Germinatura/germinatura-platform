import { adminRaffleBuyersResponseSchema, createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const rowsSchema = z.array(z.object({
  sale_id: z.uuid(), numbers: z.array(z.number().int().positive()), status: z.enum(["RESERVED", "PAID", "REFUNDED"]),
  channel: z.string(), registered: z.boolean(), buyer_name: z.string().nullable(), buyer_contact: z.string().nullable(),
  seller_name: z.string().nullable(), total_cents: z.number().int().nonnegative(), created_at: z.string(), won: z.boolean().nullable(),
}));

/** Spec 5.11 / 15.5 (RAF-006): buyers of a raffle with their contact, for raffle managers only. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const fail = (code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers });
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return fail("RAFFLE_NOT_FOUND", "Rifa não encontrada", 404);
  try {
    await requirePermission("raffles.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_raffle_buyers", { p_campaign_id: id.data });
    if (error?.message.includes("RAFFLE_CAMPAIGN_NOT_FOUND")) return fail("RAFFLE_NOT_FOUND", "Rifa não encontrada", 404);
    if (error?.message.includes("FORBIDDEN")) return fail("FORBIDDEN", "Somente a gestão de rifas vê os compradores", 403);
    const rows = rowsSchema.safeParse(data);
    if (error || !rows.success) return fail("RAFFLE_UNAVAILABLE", "Compradores temporariamente indisponíveis", 503);
    return NextResponse.json(adminRaffleBuyersResponseSchema.parse({ data: rows.data.map((row) => ({
      saleId: row.sale_id, numbers: row.numbers, status: row.status, channel: row.channel, registered: row.registered,
      buyerName: row.buyer_name, buyerContact: row.buyer_contact, sellerName: row.seller_name, totalCents: row.total_cents,
      createdAt: row.created_at, won: row.won ?? false,
    })), request_id: requestId }), { headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("RAFFLE_UNAVAILABLE", "Compradores temporariamente indisponíveis", 503);
  }
}
