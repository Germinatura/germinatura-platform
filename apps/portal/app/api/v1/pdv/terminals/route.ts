import { paymentTerminalsResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseTerminalSchema, terminalDatabaseError, terminalErrorResponse, toPaymentTerminal } from "@/lib/payment-terminals";

const preferenceSchema = z.object({ terminal_id: z.uuid().nullable(), source: z.enum(["ASSIGNED", "LAST_USED", "ONLY_ACTIVE"]).nullable() });

/**
 * Spec 6.7: active Maquininhas the seller can name when confirming a card payment, with whom each one is and (H2b) the
 * one to preselect for this seller. Any active terminal stays usable whoever holds it.
 */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("sales.create");
    const client = await createAuthenticatedSupabaseClient(request);
    const [{ data, error }, preference] = await Promise.all([
      client.rpc("list_payment_terminals", { p_include_inactive: false }),
      client.rpc("pdv_terminal_preference"),
    ]);
    if (error) return terminalDatabaseError(error.message, requestId);
    const rows = z.array(databaseTerminalSchema).safeParse(data);
    if (!rows.success) return terminalErrorResponse("TERMINALS_UNAVAILABLE", "Maquininhas temporariamente indisponíveis.", requestId, 503);
    // H2b: a failed preference only leaves the picker empty; it never hides the terminals.
    const preferred = preferenceSchema.safeParse(preference.data);
    return NextResponse.json(paymentTerminalsResponseSchema.parse({
      data: rows.data.map(toPaymentTerminal),
      preference: !preference.error && preferred.success ? { terminalId: preferred.data.terminal_id, source: preferred.data.source } : { terminalId: null, source: null },
      request_id: requestId,
    }),
      { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return terminalErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return terminalErrorResponse("TERMINALS_UNAVAILABLE", "Maquininhas temporariamente indisponíveis.", requestId, 503);
  }
}
