import { financeStatementQuerySchema, financeStatementResponseSchema } from "@germinatura/contracts";
import { toCsv } from "@germinatura/domain";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { financeEntryDatabaseError, financeEntryErrorResponse } from "@/lib/finance-entries";

const databaseStatementSchema = z.object({
  rows: z.array(z.object({
    occurred_on: z.string(), source: z.string(), source_id: z.uuid(), category: z.string().nullable(), account: z.string(),
    amount_cents: z.number().int(), description: z.string(), reference: z.string().nullable(), nature: z.string(),
  })),
  totals: z.object({
    inflow_cents: z.number().int(), outflow_cents: z.number().int(),
    by_account: z.record(z.string(), z.number().int()), by_category: z.record(z.string(), z.number().int()),
  }),
});
const sourceLabels: Record<string, string> = { SALE: "Venda", PAYABLE: "Fornecedor", MANUAL: "Manual", IMPORT: "Extrato PicPay", OPENING: "Abertura" };

/** FIN-006: consolidated statement of a São Paulo period, as JSON or as a real CSV file. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("finance.manage");
    const query = financeStatementQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return financeEntryErrorResponse("INVALID_FINANCE_QUERY", "Informe um período válido.", requestId, 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("finance_statement", { p_from: query.data.from, p_to: query.data.to });
    if (error) return financeEntryDatabaseError(error.message, requestId);
    const statement = databaseStatementSchema.safeParse(data);
    if (!statement.success) return financeEntryErrorResponse("FINANCE_UNAVAILABLE", "Extrato temporariamente indisponível.", requestId, 503);
    const response = financeStatementResponseSchema.safeParse({
      data: statement.data.rows.map((row) => ({
        occurredOn: row.occurred_on, source: row.source, sourceId: row.source_id, category: row.category, account: row.account,
        amountCents: row.amount_cents, description: row.description, reference: row.reference, nature: row.nature,
      })),
      totals: {
        inflowCents: statement.data.totals.inflow_cents, outflowCents: statement.data.totals.outflow_cents,
        byAccount: statement.data.totals.by_account, byCategory: statement.data.totals.by_category,
      },
      request_id: requestId,
    });
    if (!response.success) return financeEntryErrorResponse("FINANCE_UNAVAILABLE", "Extrato inválido.", requestId, 503);
    if (query.data.format === "csv") {
      const csv = toCsv(
        ["data", "origem", "categoria", "conta", "valor_reais", "descricao", "referencia"],
        response.data.data.map((row) => [
          row.occurredOn, sourceLabels[row.source] ?? row.source,
          row.category ?? (row.nature === "SALDO_ABERTURA" ? "SALDO_ABERTURA" : "TRANSFERENCIA"), row.account,
          { cents: row.amountCents }, row.description, row.reference,
        ]),
      );
      return new NextResponse(csv, { headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="extrato-${query.data.from}-a-${query.data.to}.csv"`,
        "Cache-Control": "no-store", "x-request-id": requestId,
      } });
    }
    return NextResponse.json(response.data, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return financeEntryErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return financeEntryErrorResponse("FINANCE_UNAVAILABLE", "Extrato temporariamente indisponível.", requestId, 503);
  }
}
