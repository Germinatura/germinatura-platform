import { createApiError, purchasePayableQuerySchema, purchasePayablesResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const balanceRowsSchema = z.array(z.object({
  id: z.uuid(), receipt_id: z.uuid(), supplier_id: z.uuid(), supplier_name: z.string(),
  amount_cents: z.number(), expected_payment_method: z.string(), settled_cents: z.number(),
  outstanding_cents: z.number(), status: z.enum(["PENDING", "SETTLED"]), created_at: z.string(),
}));
const settlementRowsSchema = z.array(z.object({
  id: z.uuid(), payable_id: z.uuid(), entry_type: z.enum(["SETTLEMENT", "REVERSAL"]),
  amount_cents: z.number(), effective_on: z.string(), payment_method: z.string(), reference: z.string(),
  reversal_of: z.uuid().nullable(), reason: z.string(), created_at: z.string(),
}));
const responseHeaders = (id: string) => ({ "Cache-Control": "no-store", "x-request-id": id });

export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  const fail = (code: string, message: string, status: number) => NextResponse.json(
    createApiError(code, message, requestId), { status, headers: responseHeaders(requestId) },
  );
  try {
    await requirePermission("finance.manage");
    const parsed = purchasePayableQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return fail("INVALID_PAYABLE_QUERY", "Consulta de contas a pagar inválida.", 422);
    const client = await createAuthenticatedSupabaseClient(request);
    let query = client.from("purchase_payable_balances").select("*")
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(21);
    if (parsed.data.status !== "ALL") query = query.eq("status", parsed.data.status);
    if (parsed.data.query) query = query.ilike("supplier_name", `%${parsed.data.query}%`);
    if (parsed.data.cursor) {
      const cursor = await client.from("purchase_payable_balances").select("created_at").eq("id", parsed.data.cursor).maybeSingle();
      if (cursor.error || !cursor.data) return fail("INVALID_PAYABLE_CURSOR", "Cursor de contas a pagar inválido.", 422);
      query = query.or(`created_at.lt.${cursor.data.created_at},and(created_at.eq.${cursor.data.created_at},id.lt.${parsed.data.cursor})`);
    }
    const { data, error } = await query;
    const rows = balanceRowsSchema.safeParse(data);
    if (error || !rows.success) return fail("FINANCE_UNAVAILABLE", "Não foi possível consultar as contas a pagar.", 503);
    const page = rows.data.slice(0, 20);
    const ids = page.map((row) => row.id);
    const historyQuery = ids.length
      ? await client.from("purchase_payable_settlements").select("id,payable_id,entry_type,amount_cents,effective_on,payment_method,reference,reversal_of,reason,created_at")
        .in("payable_id", ids).order("created_at", { ascending: false }).order("id", { ascending: false })
      : { data: [], error: null };
    const history = settlementRowsSchema.safeParse(historyQuery.data);
    if (historyQuery.error || !history.success) return fail("FINANCE_UNAVAILABLE", "Não foi possível consultar as liquidações.", 503);
    const result = purchasePayablesResponseSchema.safeParse({
      data: page.map((row) => ({
        id: row.id, receiptId: row.receipt_id, supplierId: row.supplier_id, supplierName: row.supplier_name,
        amountCents: row.amount_cents, expectedPaymentMethod: row.expected_payment_method,
        settledCents: row.settled_cents, outstandingCents: row.outstanding_cents,
        status: row.status, createdAt: row.created_at,
        settlements: history.data.filter((entry) => entry.payable_id === row.id).map((entry) => ({
          id: entry.id, payableId: entry.payable_id, entryType: entry.entry_type,
          amountCents: entry.amount_cents, effectiveOn: entry.effective_on,
          paymentMethod: entry.payment_method, reference: entry.reference,
          reversalOf: entry.reversal_of, reason: entry.reason, createdAt: entry.created_at,
        })),
      })),
      nextCursor: rows.data.length > 20 ? page.at(-1)?.id ?? null : null,
      request_id: requestId,
    });
    if (!result.success) return fail("FINANCE_UNAVAILABLE", "Dados de contas a pagar inválidos.", 503);
    return NextResponse.json(result.data, { headers: responseHeaders(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("FINANCE_UNAVAILABLE", "Não foi possível consultar as contas a pagar.", 503);
  }
}
