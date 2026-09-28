import { idempotencyKeySchema, paymentTerminalResponseSchema, savePaymentTerminalRequestSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseTerminalSchema, terminalDatabaseError, terminalErrorResponse, toPaymentTerminal } from "@/lib/payment-terminals";

interface RouteContext { params: Promise<{ id: string }>; }

/** Renames, deactivates or reactivates a Maquininha; terminals are never deleted. */
export async function PATCH(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = savePaymentTerminalRequestSchema.safeParse(await request.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !key.success || !parsed.success) {
    return terminalErrorResponse("INVALID_REQUEST", "Confira o código e o nome da maquininha.", requestId, 422);
  }
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("save_payment_terminal", {
      p_terminal_id: id, p_code: parsed.data.code, p_label: parsed.data.label, p_active: parsed.data.active,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return terminalDatabaseError(error.message, requestId);
    const row = databaseTerminalSchema.safeParse(data);
    if (!row.success) return terminalErrorResponse("TERMINALS_UNAVAILABLE", "Maquininhas temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(paymentTerminalResponseSchema.parse({ data: toPaymentTerminal(row.data), request_id: requestId }),
      { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return terminalErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return terminalErrorResponse("TERMINALS_UNAVAILABLE", "Maquininhas temporariamente indisponíveis.", requestId, 503);
  }
}
