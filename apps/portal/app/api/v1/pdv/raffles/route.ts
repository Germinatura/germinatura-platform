import { createApiError, pdvRafflesResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const rowsSchema = z.array(z.object({
  campaign_id: z.uuid(), name: z.string(), product_name: z.string(), number_count: z.number().int(), ends_at: z.string(),
  unit_price_cents: z.number().int().nullable(), available_count: z.number().int(),
}));

/** Spec 6.15: open raffles the seller can sell at the PDV. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const fail = (code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers });
  try {
    await requirePermission("raffles.sell");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_raffles_for_seller");
    const rows = rowsSchema.safeParse(data);
    if (error || !rows.success) return fail("RAFFLE_UNAVAILABLE", "Rifas temporariamente indisponíveis", 503);
    return NextResponse.json(pdvRafflesResponseSchema.parse({ data: rows.data.map((row) => ({
      campaignId: row.campaign_id, name: row.name, productName: row.product_name, numberCount: row.number_count, endsAt: row.ends_at,
      unitPriceCents: row.unit_price_cents, availableCount: row.available_count,
    })), request_id: requestId }), { headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("RAFFLE_UNAVAILABLE", "Rifas temporariamente indisponíveis", 503);
  }
}
