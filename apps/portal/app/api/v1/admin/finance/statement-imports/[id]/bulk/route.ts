import { idempotencyKeySchema, picpayStatementBulkResolveRequestSchema, picpayStatementBulkResolveResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { statementDatabaseError, statementErrorResponse } from "@/lib/picpay-statement";

interface RouteContext { params: Promise<{ id: string }>; }
const databaseResultSchema = z.object({ bulk_id: z.uuid(), count: z.number().int(), total_cents: z.number().int(), category: z.string() });

/**
 * Classifies the previewed pending lines in one transaction. The body repeats the preview's count, total and selection
 * SHA-256; the database recomputes the selection under lock and refuses when it changed.
 */
export async function POST(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = picpayStatementBulkResolveRequestSchema.safeParse(await request.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !key.success || !parsed.success) {
    return statementErrorResponse("INVALID_REQUEST", "Confira a classificação em lote.", requestId, 422);
  }
  const body = parsed.data;
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("resolve_picpay_statement_lines_bulk", {
      p_import_id: id, p_movement: body.movement, p_from: body.from, p_to: body.to, p_line_ids: body.lineIds, p_category: body.category,
      p_reason: body.reason, p_expected_count: body.expectedCount, p_expected_total_cents: body.expectedTotalCents,
      p_expected_selection_sha256: body.expectedSelectionSha256, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return statementDatabaseError(error.message, requestId);
    const row = databaseResultSchema.safeParse(data);
    if (!row.success) return statementErrorResponse("STATEMENT_UNAVAILABLE", "Classificação em lote temporariamente indisponível.", requestId, 503);
    return NextResponse.json(picpayStatementBulkResolveResponseSchema.parse({
      data: { bulkId: row.data.bulk_id, count: row.data.count, totalCents: row.data.total_cents, category: row.data.category }, request_id: requestId,
    }), { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return statementErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return statementErrorResponse("STATEMENT_UNAVAILABLE", "Classificação em lote temporariamente indisponível.", requestId, 503);
  }
}
