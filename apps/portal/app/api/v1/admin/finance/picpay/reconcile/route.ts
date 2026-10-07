import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { picpayDatabaseError, picpayErrorResponse } from "@/lib/picpay-reconciliation";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });

const databaseResultSchema = z.object({ links: z.number().int(), pix: z.number().int(), refunds: z.number().int(), settlements: z.number().int() });

/** Runs the reconciliation again (it also runs after every import and when the opening position changes). */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("run_picpay_reconciliation", { p_correlation_id: crypto.randomUUID() });
    if (error) return picpayDatabaseError(error.message, requestId);
    const row = databaseResultSchema.safeParse(data);
    if (!row.success) return picpayErrorResponse("PICPAY_UNAVAILABLE", "Conciliação temporariamente indisponível.", requestId, 503);
    return NextResponse.json({ data: row.data, request_id: requestId }, { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return picpayErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return picpayErrorResponse("PICPAY_UNAVAILABLE", "Conciliação temporariamente indisponível.", requestId, 503);
  }
}
