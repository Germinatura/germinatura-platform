import { assignPaymentTerminalRequestSchema, idempotencyKeySchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { terminalDatabaseError, terminalErrorResponse } from "@/lib/payment-terminals";

interface RouteContext { params: Promise<{ id: string }>; }
const resultSchema = z.object({ terminal_id: z.uuid(), code: z.string(), assigned_to: z.object({ id: z.uuid(), name: z.string().nullable() }).nullable() });

/** H2b: assigns, changes or removes (assigneeId null) with whom a Maquininha is in the cohort. Audited; not exclusivity. */
export async function POST(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = assignPaymentTerminalRequestSchema.safeParse(await request.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !key.success || !parsed.success) {
    return terminalErrorResponse("INVALID_REQUEST", "Escolha o responsável e informe o motivo (mínimo de 4 caracteres).", requestId, 422);
  }
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("assign_payment_terminal", {
      p_terminal_id: id, p_assignee: parsed.data.assigneeId, p_reason: parsed.data.reason,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return terminalDatabaseError(error.message, requestId);
    const row = resultSchema.safeParse(data);
    if (!row.success) return terminalErrorResponse("TERMINALS_UNAVAILABLE", "Maquininhas temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json({
      data: { terminalId: row.data.terminal_id, code: row.data.code, assignedTo: row.data.assigned_to ? { id: row.data.assigned_to.id, name: row.data.assigned_to.name ?? "Sem nome" } : null },
      request_id: requestId,
    }, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return terminalErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return terminalErrorResponse("TERMINALS_UNAVAILABLE", "Maquininhas temporariamente indisponíveis.", requestId, 503);
  }
}
