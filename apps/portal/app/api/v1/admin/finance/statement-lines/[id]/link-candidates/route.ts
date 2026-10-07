import { picpayStatementLinkCandidatesResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { statementDatabaseError, statementErrorResponse } from "@/lib/picpay-statement";

interface RouteContext { params: Promise<{ id: string }>; }
const databaseCandidatesSchema = z.array(z.object({
  kind: z.string(), id: z.uuid(), amount_cents: z.number().int(), occurred_on: z.string(), label: z.string(),
}));

/** Spec 5.8 (FIN-003): supplier payments and manual entries with the same effect on PicPay, not linked to another line. */
export async function GET(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return statementErrorResponse("INVALID_REQUEST", "Linha inválida.", requestId, 422);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_statement_link_candidates", { p_line_id: id });
    if (error) return statementDatabaseError(error.message, requestId);
    const rows = databaseCandidatesSchema.safeParse(data);
    if (!rows.success) return statementErrorResponse("STATEMENT_UNAVAILABLE", "Registros temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(picpayStatementLinkCandidatesResponseSchema.parse({
      data: rows.data.map((row) => ({ kind: row.kind, id: row.id, amountCents: row.amount_cents, occurredOn: row.occurred_on, label: row.label })),
      request_id: requestId,
    }), { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return statementErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return statementErrorResponse("STATEMENT_UNAVAILABLE", "Registros temporariamente indisponíveis.", requestId, 503);
  }
}
