import { closePicpayPeriodRequestSchema, idempotencyKeySchema, picpayPeriodsResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databasePeriodSchema, picpayDatabaseError, picpayErrorResponse, toPeriod } from "@/lib/picpay-reconciliation";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });

const databaseCloseSchema = z.object({ id: z.uuid(), status: z.enum(["CONCILIADO", "COM_PENDENCIAS"]), open_exceptions: z.number().int() });

/** Evaluated reconciliation periods and their current status (later evidence sends one back to review). */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_picpay_periods", { p_limit: 50 });
    if (error) return picpayDatabaseError(error.message, requestId);
    const rows = z.array(databasePeriodSchema).safeParse(data);
    if (!rows.success) return picpayErrorResponse("PICPAY_UNAVAILABLE", "Fechamentos temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(picpayPeriodsResponseSchema.parse({ data: rows.data.map(toPeriod), request_id: requestId }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return picpayErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return picpayErrorResponse("PICPAY_UNAVAILABLE", "Fechamentos temporariamente indisponíveis.", requestId, 503);
  }
}

/** Evaluates a period: reconciled with no open exception, otherwise with exceptions. */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = closePicpayPeriodRequestSchema.safeParse(await request.json().catch(() => null));
  if (!key.success || !parsed.success) return picpayErrorResponse("INVALID_REQUEST", "Informe um período válido.", requestId, 422);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("close_picpay_period", {
      p_from: parsed.data.from, p_to: parsed.data.to, p_note: parsed.data.note, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return picpayDatabaseError(error.message, requestId);
    const row = databaseCloseSchema.safeParse(data);
    if (!row.success) return picpayErrorResponse("PICPAY_UNAVAILABLE", "Fechamento temporariamente indisponível.", requestId, 503);
    return NextResponse.json({ data: { id: row.data.id, status: row.data.status, openExceptions: row.data.open_exceptions }, request_id: requestId },
      { status: 201, headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return picpayErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return picpayErrorResponse("PICPAY_UNAVAILABLE", "Fechamento temporariamente indisponível.", requestId, 503);
  }
}
