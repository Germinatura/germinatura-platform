import { idempotencyKeySchema, paymentTerminalResponseSchema, paymentTerminalsResponseSchema, savePaymentTerminalRequestSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseTerminalSchema, terminalDatabaseError, terminalErrorResponse, toPaymentTerminal } from "@/lib/payment-terminals";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });

/** Spec 6.7: finance lists every registered Maquininha, inactive ones included. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_payment_terminals", { p_include_inactive: true });
    if (error) return terminalDatabaseError(error.message, requestId);
    const rows = z.array(databaseTerminalSchema).safeParse(data);
    if (!rows.success) return terminalErrorResponse("TERMINALS_UNAVAILABLE", "Maquininhas temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(paymentTerminalsResponseSchema.parse({ data: rows.data.map(toPaymentTerminal), request_id: requestId }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return terminalErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return terminalErrorResponse("TERMINALS_UNAVAILABLE", "Maquininhas temporariamente indisponíveis.", requestId, 503);
  }
}

/** Registers a Maquininha under an internal code. */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = savePaymentTerminalRequestSchema.safeParse(await request.json().catch(() => null));
  if (!key.success || !parsed.success) return terminalErrorResponse("INVALID_REQUEST", "Confira o código e o nome da maquininha.", requestId, 422);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("save_payment_terminal", {
      p_terminal_id: null, p_code: parsed.data.code, p_label: parsed.data.label, p_active: parsed.data.active,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return terminalDatabaseError(error.message, requestId);
    const row = databaseTerminalSchema.safeParse(data);
    if (!row.success) return terminalErrorResponse("TERMINALS_UNAVAILABLE", "Maquininhas temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(paymentTerminalResponseSchema.parse({ data: toPaymentTerminal(row.data), request_id: requestId }), { status: 201, headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return terminalErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return terminalErrorResponse("TERMINALS_UNAVAILABLE", "Maquininhas temporariamente indisponíveis.", requestId, 503);
  }
}
