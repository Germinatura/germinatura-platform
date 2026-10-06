import { picpayStatementBulkPreviewRequestSchema, picpayStatementBulkPreviewResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseBulkPreviewSchema, statementDatabaseError, statementErrorResponse, toBulkPreview } from "@/lib/picpay-statement";

interface RouteContext { params: Promise<{ id: string }>; }

/** Spec 5.8 (FIN-007): what a bulk classification of pending lines would do. Nothing is written. */
export async function POST(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  const parsed = picpayStatementBulkPreviewRequestSchema.safeParse(await request.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !parsed.success) return statementErrorResponse("INVALID_REQUEST", "Confira a seleção.", requestId, 422);
  const body = parsed.data;
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("preview_picpay_statement_bulk", {
      p_import_id: id, p_movement: body.movement, p_from: body.from, p_to: body.to, p_line_ids: body.lineIds, p_category: body.category,
    });
    if (error) return statementDatabaseError(error.message, requestId);
    const row = databaseBulkPreviewSchema.safeParse(data);
    if (!row.success) return statementErrorResponse("STATEMENT_UNAVAILABLE", "Prévia temporariamente indisponível.", requestId, 503);
    return NextResponse.json(picpayStatementBulkPreviewResponseSchema.parse({ data: toBulkPreview(row.data), request_id: requestId }),
      { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return statementErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return statementErrorResponse("STATEMENT_UNAVAILABLE", "Prévia temporariamente indisponível.", requestId, 503);
  }
}
