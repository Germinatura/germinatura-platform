import { picpayFilePreviewResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseFilePreviewSchema, picpayDatabaseError, picpayErrorResponse, readPicpayFile, toFilePreview } from "@/lib/picpay-reconciliation";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });

/** Read-only preview of an export: detected type, period, rows, new, known, changed and ambiguous ones, errors. */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("finance.manage");
    const file = await readPicpayFile(request);
    if ("error" in file) return picpayErrorResponse(file.error, file.message, requestId, 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("preview_picpay_file", { p_content: file.content });
    if (error) return picpayDatabaseError(error.message, requestId);
    const row = databaseFilePreviewSchema.safeParse(data);
    if (!row.success) return picpayErrorResponse("PICPAY_UNAVAILABLE", "Prévia temporariamente indisponível.", requestId, 503);
    return NextResponse.json(picpayFilePreviewResponseSchema.parse({ data: toFilePreview(row.data), request_id: requestId }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return picpayErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return picpayErrorResponse("PICPAY_UNAVAILABLE", "Prévia temporariamente indisponível.", requestId, 503);
  }
}
