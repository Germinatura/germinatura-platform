import {
  createApiError, createSellerShareLinkRequestSchema, idempotencyKeySchema, sellerShareLinkResponseSchema, sellerShareLinksResponseSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseShareCampaignSchema, toShareCampaign } from "@/lib/share-campaigns";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });
const fail = (code: string, message: string, requestId: string, status: number) =>
  NextResponse.json(createApiError(code, message, requestId), { status, headers: headers(requestId) });
const listSchema = z.object({
  links: z.array(databaseShareCampaignSchema),
  campaigns: z.array(z.object({ code: z.string(), title: z.string(), channel: z.string(), mine: z.boolean() })),
});

/** GROW-002: the seller's own tracked links with their results, and the campaigns a PDV sale can come from. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("sales.create");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_my_share_links");
    const rows = listSchema.safeParse(data);
    if (error || !rows.success) return fail("SHARE_UNAVAILABLE", "Divulgação temporariamente indisponível.", requestId, 503);
    return NextResponse.json(sellerShareLinksResponseSchema.parse({
      data: { links: rows.data.links.map(toShareCampaign), campaigns: rows.data.campaigns }, request_id: requestId,
    }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return fail("SHARE_UNAVAILABLE", "Divulgação temporariamente indisponível.", requestId, 503);
  }
}

/** Creates a tracked link that counts for the seller who made it. */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = createSellerShareLinkRequestSchema.safeParse(await request.json().catch(() => null));
  if (!key.success || !parsed.success) return fail("INVALID_SHARE_CAMPAIGN", "Confira o título e os produtos do link.", requestId, 422);
  try {
    await requirePermission("sales.create");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("create_seller_share_link", {
      p_title: parsed.data.title, p_channel: parsed.data.channel, p_product_ids: parsed.data.productIds,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      if (error.message.includes("INVALID_SHARE_CAMPAIGN")) return fail("INVALID_SHARE_CAMPAIGN", "Escolha produtos publicados.", requestId, 422);
      if (error.message.includes("IDEMPOTENCY")) return fail("IDEMPOTENCY_CONFLICT", "A solicitação já está em processamento.", requestId, 409);
      if (error.code === "42501") return fail("FORBIDDEN", "Operação não autorizada.", requestId, 403);
      return fail("SHARE_UNAVAILABLE", "Divulgação temporariamente indisponível.", requestId, 503);
    }
    const row = databaseShareCampaignSchema.safeParse(data);
    if (!row.success) return fail("SHARE_UNAVAILABLE", "Divulgação temporariamente indisponível.", requestId, 503);
    return NextResponse.json(sellerShareLinkResponseSchema.parse({ data: toShareCampaign(row.data), request_id: requestId }),
      { status: 201, headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return fail("SHARE_UNAVAILABLE", "Divulgação temporariamente indisponível.", requestId, 503);
  }
}
