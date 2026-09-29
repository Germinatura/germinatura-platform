import {
  createApiError, createShareCampaignRequestSchema, createShareCampaignResponseSchema, idempotencyKeySchema, shareCampaignsResponseSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });
const fail = (code: string, message: string, requestId: string, status: number) =>
  NextResponse.json(createApiError(code, message, requestId), { status, headers: headers(requestId) });
const rowsSchema = z.array(z.object({
  id: z.uuid(), code: z.string(), title: z.string(), channel: z.string(), product_ids: z.array(z.uuid()), created_at: z.string(),
  created_by_name: z.string(), visits: z.number().int(), reservations: z.number().int(), reserved_total_cents: z.number().int(),
}));
const createdSchema = z.object({ id: z.uuid(), code: z.string(), title: z.string(), channel: z.string(), product_ids: z.array(z.uuid()) });

/** GROW-001: share campaigns with visits and attributed reservations. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("communications.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_share_campaigns", { p_limit: 50 });
    const rows = rowsSchema.safeParse(data);
    if (error || !rows.success) return fail("SHARE_UNAVAILABLE", "Divulgações temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(shareCampaignsResponseSchema.parse({
      data: rows.data.map((row) => ({
        id: row.id, code: row.code, title: row.title, channel: row.channel, productIds: row.product_ids, createdAt: row.created_at,
        createdByName: row.created_by_name, visits: row.visits, reservations: row.reservations, reservedTotalCents: row.reserved_total_cents,
      })),
      request_id: requestId,
    }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return fail("SHARE_UNAVAILABLE", "Divulgações temporariamente indisponíveis.", requestId, 503);
  }
}

/** Creates a campaign and its tracked code; the Portal builds the text with current prices. */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = createShareCampaignRequestSchema.safeParse(await request.json().catch(() => null));
  if (!key.success || !parsed.success) return fail("INVALID_SHARE_CAMPAIGN", "Confira o título, o canal e os produtos.", requestId, 422);
  try {
    await requirePermission("communications.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("create_share_campaign", {
      p_title: parsed.data.title, p_channel: parsed.data.channel, p_product_ids: parsed.data.productIds,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error?.message.includes("INVALID_SHARE_CAMPAIGN")) return fail("INVALID_SHARE_CAMPAIGN", "Só produtos publicados podem ser divulgados.", requestId, 422);
    if (error?.message.includes("IDEMPOTENCY_CONFLICT")) return fail("IDEMPOTENCY_CONFLICT", "A chave já foi usada com outro conteúdo.", requestId, 409);
    const row = createdSchema.safeParse(data);
    if (error || !row.success) return fail("SHARE_UNAVAILABLE", "Divulgações temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(createShareCampaignResponseSchema.parse({
      data: { id: row.data.id, code: row.data.code, title: row.data.title, channel: row.data.channel, productIds: row.data.product_ids },
      request_id: requestId,
    }), { status: 201, headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return fail("SHARE_UNAVAILABLE", "Divulgações temporariamente indisponíveis.", requestId, 503);
  }
}
