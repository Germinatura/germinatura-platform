import { paymentTerminalsResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseTerminalSchema, terminalDatabaseError, terminalErrorResponse, toPaymentTerminal } from "@/lib/payment-terminals";

/** Spec 6.7: active Maquininhas the seller can name when confirming a card payment. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("sales.create");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_payment_terminals", { p_include_inactive: false });
    if (error) return terminalDatabaseError(error.message, requestId);
    const rows = z.array(databaseTerminalSchema).safeParse(data);
    if (!rows.success) return terminalErrorResponse("TERMINALS_UNAVAILABLE", "Maquininhas temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(paymentTerminalsResponseSchema.parse({ data: rows.data.map(toPaymentTerminal), request_id: requestId }),
      { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return terminalErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return terminalErrorResponse("TERMINALS_UNAVAILABLE", "Maquininhas temporariamente indisponíveis.", requestId, 503);
  }
}
