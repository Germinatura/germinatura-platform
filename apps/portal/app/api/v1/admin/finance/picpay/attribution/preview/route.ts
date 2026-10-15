import { picpayAssignmentPreviewResponseSchema, picpayAssignmentSelectionSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { requireAdminMaster } from "@/lib/cohort-admin";
import { selectionArgs, toAssignmentPreview } from "@/lib/picpay-attribution";
import { picpayDatabaseError, picpayErrorResponse } from "@/lib/picpay-reconciliation";

/** E0 (ADR 0011), ADMIN_MASTER: what an attribution to the cohort of the request would take, before confirming it. */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const body = picpayAssignmentSelectionSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return picpayErrorResponse("INVALID_REQUEST", "Escolha um arquivo inteiro ou itens.", requestId, 422);
  try {
    await requireAdminMaster();
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("preview_picpay_assignment", selectionArgs(body.data));
    if (error) return picpayDatabaseError(error.message, requestId);
    return NextResponse.json(picpayAssignmentPreviewResponseSchema.parse({ data: toAssignmentPreview(data), request_id: requestId }),
      { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return picpayErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return picpayErrorResponse("PICPAY_UNAVAILABLE", "Prévia temporariamente indisponível.", requestId, 503);
  }
}
