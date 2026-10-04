import { picpayStatementPreviewResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databasePreviewSchema, readStatementFile, statementDatabaseError, statementErrorResponse, toPreview } from "@/lib/picpay-statement";

/** Spec 5.8: read-only preview of a PicPay Empresas CSV; the body is the file itself. */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("finance.manage");
    const file = await readStatementFile(request);
    if ("error" in file) return statementErrorResponse(file.error, file.message, requestId, 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("preview_picpay_statement", { p_content: file.content });
    if (error) return statementDatabaseError(error.message, requestId);
    const preview = databasePreviewSchema.safeParse(data);
    if (!preview.success) return statementErrorResponse("STATEMENT_UNAVAILABLE", "Prévia temporariamente indisponível.", requestId, 503);
    return NextResponse.json(picpayStatementPreviewResponseSchema.parse({ data: toPreview(preview.data), request_id: requestId }),
      { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return statementErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return statementErrorResponse("STATEMENT_UNAVAILABLE", "Prévia temporariamente indisponível.", requestId, 503);
  }
}
