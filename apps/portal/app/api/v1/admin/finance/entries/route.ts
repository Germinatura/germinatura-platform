import {
  financeEntriesQuerySchema, financeEntriesResponseSchema, financeEntryResponseSchema, idempotencyKeySchema, recordFinanceEntryRequestSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseFinanceEntrySchema, financeEntryDatabaseError, financeEntryErrorResponse, toFinanceEntry } from "@/lib/finance-entries";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });
const databaseListSchema = z.object({
  items: z.array(databaseFinanceEntrySchema),
  next_cursor: z.uuid().nullable(),
  totals: z.object({
    inflow_cents: z.number().int(), outflow_cents: z.number().int(),
    by_account: z.record(z.string(), z.number().int()), by_category: z.record(z.string(), z.number().int()),
  }),
});

/** Spec 5.8: manual entries of a São Paulo period with net effects by account and category. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("finance.manage");
    const query = financeEntriesQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return financeEntryErrorResponse("INVALID_FINANCE_QUERY", "Informe um período válido.", requestId, 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_finance_entries", {
      p_from: query.data.from, p_to: query.data.to, p_category: query.data.category ?? null,
      p_account: query.data.account ?? null, p_cursor: query.data.cursor ?? null, p_limit: 50,
    });
    if (error) return financeEntryDatabaseError(error.message, requestId);
    const rows = databaseListSchema.safeParse(data);
    if (!rows.success) return financeEntryErrorResponse("FINANCE_UNAVAILABLE", "Lançamentos temporariamente indisponíveis.", requestId, 503);
    const response = financeEntriesResponseSchema.safeParse({
      data: rows.data.items.map(toFinanceEntry), nextCursor: rows.data.next_cursor,
      totals: {
        inflowCents: rows.data.totals.inflow_cents, outflowCents: rows.data.totals.outflow_cents,
        byAccount: rows.data.totals.by_account, byCategory: rows.data.totals.by_category,
      },
      request_id: requestId,
    });
    if (!response.success) return financeEntryErrorResponse("FINANCE_UNAVAILABLE", "Lançamentos inválidos.", requestId, 503);
    return NextResponse.json(response.data, { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return financeEntryErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return financeEntryErrorResponse("FINANCE_UNAVAILABLE", "Lançamentos temporariamente indisponíveis.", requestId, 503);
  }
}

/** Records an expense, an income or a treasury transfer. */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = recordFinanceEntryRequestSchema.safeParse(await request.json().catch(() => null));
  if (!key.success || !parsed.success) return financeEntryErrorResponse("INVALID_REQUEST", "Confira os dados do lançamento.", requestId, 422);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("record_finance_entry", {
      p_kind: parsed.data.kind, p_category: parsed.data.category, p_account: parsed.data.account,
      p_counter_account: parsed.data.counterAccount, p_amount_cents: parsed.data.amountCents, p_occurred_on: parsed.data.occurredOn,
      p_description: parsed.data.description, p_reference: parsed.data.reference,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return financeEntryDatabaseError(error.message, requestId);
    const row = databaseFinanceEntrySchema.safeParse(data);
    if (!row.success) return financeEntryErrorResponse("FINANCE_UNAVAILABLE", "Lançamentos temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(financeEntryResponseSchema.parse({ data: toFinanceEntry(row.data), request_id: requestId }), { status: 201, headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return financeEntryErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return financeEntryErrorResponse("FINANCE_UNAVAILABLE", "Lançamentos temporariamente indisponíveis.", requestId, 503);
  }
}
