import {
  idempotencyKeySchema, picpayAssignmentRequestSchema, picpayAssignmentResponseSchema,
  picpayAttributionStatusResponseSchema, picpayUnassignedItemsResponseSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { requireAdminMaster } from "@/lib/cohort-admin";
import { selectionArgs, toAssignmentPreview, toAttributionStatus, toUnassignedItems } from "@/lib/picpay-attribution";
import { picpayDatabaseError, picpayErrorResponse } from "@/lib/picpay-reconciliation";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });

function failure(error: unknown, requestId: string) {
  if (error instanceof AuthorizationError) return picpayErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
  return picpayErrorResponse("PICPAY_UNAVAILABLE", "Atribuição PicPay temporariamente indisponível.", requestId, 503);
}

/**
 * E0 (ADR 0011), ADMIN_MASTER: the isolation switch, what is still unassigned and each file's declaration; with
 * `importId`, the unassigned items of that file (for attribution item by item).
 */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  const importId = new URL(request.url).searchParams.get("importId");
  if (importId !== null && !z.uuid().safeParse(importId).success) return picpayErrorResponse("INVALID_REQUEST", "Arquivo inválido.", requestId, 422);
  try {
    await requireAdminMaster();
    const client = await createAuthenticatedSupabaseClient(request);
    if (importId) {
      const { data, error } = await client.rpc("list_unassigned_picpay_evidence", { p_import_id: importId, p_limit: 500 });
      if (error) return picpayDatabaseError(error.message, requestId);
      return NextResponse.json(picpayUnassignedItemsResponseSchema.parse({ data: toUnassignedItems(data), request_id: requestId }), { headers: headers(requestId) });
    }
    const { data, error } = await client.rpc("picpay_attribution_status");
    if (error) return picpayDatabaseError(error.message, requestId);
    return NextResponse.json(picpayAttributionStatusResponseSchema.parse({ data: toAttributionStatus(data), request_id: requestId }), { headers: headers(requestId) });
  } catch (error) {
    return failure(error, requestId);
  }
}

/** Attributes unassigned evidence (a whole file, or items) to the cohort of the request, confirming the preview. */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const body = picpayAssignmentRequestSchema.safeParse(await request.json().catch(() => null));
  if (!key.success || !body.success) return picpayErrorResponse("INVALID_REQUEST", "Confira a seleção, o motivo e a prévia.", requestId, 422);
  try {
    await requireAdminMaster();
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("assign_picpay_evidence", {
      ...selectionArgs(body.data), p_reason: body.data.reason, p_expected_count: body.data.expectedCount,
      p_expected_total_cents: body.data.expectedTotalCents, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return picpayDatabaseError(error.message, requestId);
    const stored = z.object({ batch_id: z.uuid(), reason: z.string() }).passthrough().parse(data);
    const preview = toAssignmentPreview(data);
    return NextResponse.json(picpayAssignmentResponseSchema.parse({
      data: { ...preview, batchId: stored.batch_id, reason: stored.reason }, request_id: requestId,
    }), { status: 201, headers: headers(requestId) });
  } catch (error) {
    return failure(error, requestId);
  }
}
