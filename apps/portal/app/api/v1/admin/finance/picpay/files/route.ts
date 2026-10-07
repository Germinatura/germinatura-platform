import { idempotencyKeySchema, picpayImportResponseSchema, picpayImportsResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseImportSchema, picpayDatabaseError, picpayErrorResponse, readPicpayFile, toImport } from "@/lib/picpay-reconciliation";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });

const fileNameSchema = z.string().trim().min(1).max(200);
const databaseImportResultSchema = databaseImportSchema.extend({
  reconciliation: z.object({ links: z.number().int(), pix: z.number().int(), refunds: z.number().int(), settlements: z.number().int() }),
  periods_flagged: z.number().int(),
});

/** Spec 5.8: every imported PicPay export (Minhas vendas, Recebíveis, Extrato), newest first. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_picpay_imports", { p_limit: 100 });
    if (error) return picpayDatabaseError(error.message, requestId);
    const rows = z.array(databaseImportSchema).safeParse(data);
    if (!rows.success) return picpayErrorResponse("PICPAY_UNAVAILABLE", "Importações temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(picpayImportsResponseSchema.parse({ data: rows.data.map(toImport), request_id: requestId }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return picpayErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return picpayErrorResponse("PICPAY_UNAVAILABLE", "Importações temporariamente indisponíveis.", requestId, 503);
  }
}

/** Imports one export, detected from its header; the database deduplicates across files and reconciles. */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const fileName = fileNameSchema.safeParse(new URL(request.url).searchParams.get("fileName"));
  if (!key.success || !fileName.success) return picpayErrorResponse("INVALID_REQUEST", "Informe o arquivo exportado do PicPay.", requestId, 422);
  try {
    await requirePermission("finance.manage");
    const file = await readPicpayFile(request);
    if ("error" in file) return picpayErrorResponse(file.error, file.message, requestId, 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("import_picpay_file", {
      p_file_name: fileName.data, p_content: file.content, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return picpayDatabaseError(error.message, requestId);
    const row = databaseImportResultSchema.safeParse(data);
    if (!row.success) return picpayErrorResponse("PICPAY_UNAVAILABLE", "Importação temporariamente indisponível.", requestId, 503);
    return NextResponse.json(picpayImportResponseSchema.parse({
      data: { ...toImport(row.data), reconciliation: row.data.reconciliation, periodsFlagged: row.data.periods_flagged }, request_id: requestId,
    }), { status: 201, headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return picpayErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return picpayErrorResponse("PICPAY_UNAVAILABLE", "Importação temporariamente indisponível.", requestId, 503);
  }
}
