import { picpayStatementLinesQuerySchema, picpayStatementLinesResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import {
  databaseImportSchema, databaseLineSchema, statementDatabaseError, statementErrorResponse, toImport, toLine,
} from "@/lib/picpay-statement";

interface RouteContext { params: Promise<{ id: string }>; }
const databaseLinesSchema = z.object({
  import: databaseImportSchema, items: z.array(databaseLineSchema), next_after: z.number().int().nullable(),
});

/** Lines of one imported statement with their current decision and the internal candidates of pending ones. */
export async function GET(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  const query = picpayStatementLinesQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!z.uuid().safeParse(id).success || !query.success) return statementErrorResponse("INVALID_REQUEST", "Consulta inválida.", requestId, 422);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_picpay_statement_lines", {
      p_import_id: id, p_pending_only: query.data.pending === "true", p_after_line: query.data.after ?? null, p_limit: 50,
    });
    if (error) return statementDatabaseError(error.message, requestId);
    const rows = databaseLinesSchema.safeParse(data);
    if (!rows.success) return statementErrorResponse("STATEMENT_UNAVAILABLE", "Linhas temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(picpayStatementLinesResponseSchema.parse({
      import: toImport(rows.data.import), data: rows.data.items.map(toLine), nextAfter: rows.data.next_after, request_id: requestId,
    }), { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return statementErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return statementErrorResponse("STATEMENT_UNAVAILABLE", "Linhas temporariamente indisponíveis.", requestId, 503);
  }
}
