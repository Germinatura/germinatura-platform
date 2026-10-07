import { picpayPeriodQuerySchema, picpaySettlementsResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { picpayDatabaseError, picpayErrorResponse } from "@/lib/picpay-reconciliation";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });

const n = z.number().int();
const databaseSettlementsSchema = z.object({
  days: z.array(z.object({ payment_on: z.string(), expected_net_cents: n, expected_count: n, settled_cents: n, settled_lines: n,
    receivable_snapshot_cents: n, statement_covered: z.boolean(), status: z.string() })),
  receivables: z.array(z.object({ id: z.uuid(), transaction_ref: z.string(), installment: n, installments_total: n, payment_on: z.string(),
    status: z.string(), gross_cents: n, discount_cents: n, net_cents: n, terminal: z.string().nullable(), snapshots: n, last_snapshot: n })),
});

/** Card settlement by payment day (expected by Minhas vendas, settled by the Extrato) and the latest receivable snapshot. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("finance.manage");
    const query = picpayPeriodQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return picpayErrorResponse("INVALID_REQUEST", "Informe um período válido.", requestId, 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_picpay_settlements", { p_from: query.data.from, p_to: query.data.to });
    if (error) return picpayDatabaseError(error.message, requestId);
    const row = databaseSettlementsSchema.safeParse(data);
    if (!row.success) return picpayErrorResponse("PICPAY_UNAVAILABLE", "Liquidações temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(picpaySettlementsResponseSchema.parse({
      data: {
        days: row.data.days.map((day) => ({ paymentOn: day.payment_on, expectedNetCents: day.expected_net_cents, expectedCount: day.expected_count,
          settledCents: day.settled_cents, settledLines: day.settled_lines, receivableSnapshotCents: day.receivable_snapshot_cents,
          statementCovered: day.statement_covered, status: day.status })),
        receivables: row.data.receivables.map((item) => ({ id: item.id, transactionRef: item.transaction_ref, installment: item.installment,
          installmentsTotal: item.installments_total, paymentOn: item.payment_on, status: item.status, grossCents: item.gross_cents,
          discountCents: item.discount_cents, netCents: item.net_cents, terminal: item.terminal, snapshots: item.snapshots, lastSnapshot: item.last_snapshot })),
      },
      request_id: requestId,
    }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return picpayErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return picpayErrorResponse("PICPAY_UNAVAILABLE", "Liquidações temporariamente indisponíveis.", requestId, 503);
  }
}
