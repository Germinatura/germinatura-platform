import { createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requireSession } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const rowsSchema = z.array(z.object({ product_id: z.uuid() }));

/** NOTIF-004: products the caller asked to be told about when they are back. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  try {
    const user = await requireSession();
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.from("product_stock_alerts").select("product_id").eq("user_id", user.id).is("notified_at", null).limit(200);
    const rows = rowsSchema.safeParse(data);
    if (error || !rows.success) return NextResponse.json(createApiError("STOCK_ALERTS_UNAVAILABLE", "Avisos temporariamente indisponíveis.", requestId), { status: 503, headers });
    return NextResponse.json({ data: rows.data.map((row) => row.product_id), request_id: requestId }, { headers });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return NextResponse.json(createApiError(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId), { status: error.status, headers });
    }
    return NextResponse.json(createApiError("STOCK_ALERTS_UNAVAILABLE", "Avisos temporariamente indisponíveis.", requestId), { status: 503, headers });
  }
}
