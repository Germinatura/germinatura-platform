import {
  financeBalanceCheckResponseSchema, financeBalanceChecksResponseSchema, idempotencyKeySchema, recordFinanceBalanceCheckRequestSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseBalanceCheckSchema, toBalanceCheck, treasuryDatabaseError, treasuryErrorResponse } from "@/lib/finance-treasury";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });
const databaseListSchema = z.object({ items: z.array(databaseBalanceCheckSchema), next_before: z.number().int().nullable() });

/** Spec 5.8 (FIN-003): recorded balance checks, newest first. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("finance.manage");
    const before = new URL(request.url).searchParams.get("before");
    const parsedBefore = before === null ? null : z.coerce.number().int().positive().safeParse(before);
    if (parsedBefore && !parsedBefore.success) return treasuryErrorResponse("INVALID_REQUEST", "Consulta inválida.", requestId, 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_finance_balance_checks", { p_before_number: parsedBefore?.data ?? null, p_limit: 20 });
    if (error) return treasuryDatabaseError(error.message, requestId);
    const rows = databaseListSchema.safeParse(data);
    if (!rows.success) return treasuryErrorResponse("FINANCE_UNAVAILABLE", "Conferências temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(financeBalanceChecksResponseSchema.parse({
      data: rows.data.items.map(toBalanceCheck), nextBefore: rows.data.next_before, request_id: requestId,
    }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return treasuryErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return treasuryErrorResponse("FINANCE_UNAVAILABLE", "Conferências temporariamente indisponíveis.", requestId, 503);
  }
}

/** Compares the position observed in PicPay with the computed balances; a difference never creates an adjustment. */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = recordFinanceBalanceCheckRequestSchema.safeParse(await request.json().catch(() => null));
  if (!key.success || !parsed.success) return treasuryErrorResponse("INVALID_REQUEST", "Confira os saldos observados.", requestId, 422);
  const body = parsed.data;
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("record_finance_balance_check", {
      p_as_of: body.asOf, p_observed_free_cents: body.observedFreeCents, p_observed_vault_cents: body.observedVaultCents,
      p_note: body.note, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return treasuryDatabaseError(error.message, requestId);
    const row = databaseBalanceCheckSchema.safeParse(data);
    if (!row.success) return treasuryErrorResponse("FINANCE_UNAVAILABLE", "Conferência temporariamente indisponível.", requestId, 503);
    return NextResponse.json(financeBalanceCheckResponseSchema.parse({ data: toBalanceCheck(row.data), request_id: requestId }),
      { status: 201, headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return treasuryErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return treasuryErrorResponse("FINANCE_UNAVAILABLE", "Conferência temporariamente indisponível.", requestId, 503);
  }
}
