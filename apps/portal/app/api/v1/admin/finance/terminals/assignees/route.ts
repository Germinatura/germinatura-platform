import { paymentTerminalAssigneesResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { terminalDatabaseError, terminalErrorResponse } from "@/lib/payment-terminals";

const rowsSchema = z.array(z.object({ id: z.uuid(), name: z.string().nullable(), username: z.string().nullable() }));

/** H2b: the active sellers of the cohort who may hold a Maquininha. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_payment_terminal_assignees");
    if (error) return terminalDatabaseError(error.message, requestId);
    const rows = rowsSchema.safeParse(data);
    if (!rows.success) return terminalErrorResponse("TERMINALS_UNAVAILABLE", "Maquininhas temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(paymentTerminalAssigneesResponseSchema.parse({
      data: rows.data.map((row) => ({ id: row.id, name: row.name ?? row.username ?? "Sem nome", username: row.username })), request_id: requestId,
    }), { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return terminalErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return terminalErrorResponse("TERMINALS_UNAVAILABLE", "Maquininhas temporariamente indisponíveis.", requestId, 503);
  }
}
