import {
  financeOpeningPositionRecordedResponseSchema, financeOpeningPositionResponseSchema, idempotencyKeySchema,
  recordFinanceOpeningPositionRequestSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseOpeningPositionSchema, toOpeningPosition, treasuryDatabaseError, treasuryErrorResponse } from "@/lib/finance-treasury";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });
const databaseResultSchema = z.object({ current: databaseOpeningPositionSchema.nullable(), versions: z.array(databaseOpeningPositionSchema) });

/** Spec 5.8 (FIN-002): the current cutover opening position and every earlier version. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("get_finance_opening_position");
    if (error) return treasuryDatabaseError(error.message, requestId);
    const row = databaseResultSchema.safeParse(data);
    if (!row.success) return treasuryErrorResponse("FINANCE_UNAVAILABLE", "Abertura temporariamente indisponível.", requestId, 503);
    return NextResponse.json(financeOpeningPositionResponseSchema.parse({
      data: { current: row.data.current ? toOpeningPosition(row.data.current) : null, versions: row.data.versions.map(toOpeningPosition) },
      request_id: requestId,
    }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return treasuryErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return treasuryErrorResponse("FINANCE_UNAVAILABLE", "Abertura temporariamente indisponível.", requestId, 503);
  }
}

/** Records the opening position, or a corrected version that supersedes the current one with a reason. */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = recordFinanceOpeningPositionRequestSchema.safeParse(await request.json().catch(() => null));
  if (!key.success || !parsed.success) return treasuryErrorResponse("INVALID_REQUEST", "Confira a posição de abertura.", requestId, 422);
  const body = parsed.data;
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("record_finance_opening_position", {
      p_as_of: body.asOf, p_operating_since: body.operatingSince, p_free_cents: body.freeCents, p_vault_cents: body.vaultCents,
      p_receivables_cents: body.receivablesCents, p_cash_cents: body.cashCents, p_description: body.description, p_reason: body.reason,
      p_supersedes_id: body.supersedesId, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return treasuryDatabaseError(error.message, requestId);
    const row = databaseOpeningPositionSchema.safeParse(data);
    if (!row.success) return treasuryErrorResponse("FINANCE_UNAVAILABLE", "Abertura temporariamente indisponível.", requestId, 503);
    return NextResponse.json(financeOpeningPositionRecordedResponseSchema.parse({ data: toOpeningPosition(row.data), request_id: requestId }),
      { status: 201, headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return treasuryErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return treasuryErrorResponse("FINANCE_UNAVAILABLE", "Abertura temporariamente indisponível.", requestId, 503);
  }
}
