import {
  idempotencyKeySchema, picpayStatementImportQuerySchema, picpayStatementImportResponseSchema, picpayStatementImportsResponseSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseImportSchema, readStatementFile, statementDatabaseError, statementErrorResponse, toImport } from "@/lib/picpay-statement";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });
const databaseListSchema = z.object({
  items: z.array(databaseImportSchema), next_before: z.number().int().nullable(), pending_total: z.number().int(),
});

/** Spec 5.8: imported PicPay statements, newest first, with the lines still waiting for review. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("finance.manage");
    const before = new URL(request.url).searchParams.get("before");
    const parsedBefore = before === null ? null : z.coerce.number().int().positive().safeParse(before);
    if (parsedBefore && !parsedBefore.success) return statementErrorResponse("INVALID_REQUEST", "Consulta inválida.", requestId, 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_picpay_statement_imports", { p_before_number: parsedBefore?.data ?? null, p_limit: 20 });
    if (error) return statementDatabaseError(error.message, requestId);
    const rows = databaseListSchema.safeParse(data);
    if (!rows.success) return statementErrorResponse("STATEMENT_UNAVAILABLE", "Importações temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(picpayStatementImportsResponseSchema.parse({
      data: rows.data.items.map(toImport), nextBefore: rows.data.next_before, pendingTotal: rows.data.pending_total, request_id: requestId,
    }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return statementErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return statementErrorResponse("STATEMENT_UNAVAILABLE", "Importações temporariamente indisponíveis.", requestId, 503);
  }
}

/** Imports the file in the body once; the database refuses the same file again and any invalid line. */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const query = picpayStatementImportQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!key.success || !query.success) return statementErrorResponse("INVALID_REQUEST", "Informe o arquivo do extrato.", requestId, 422);
  try {
    await requirePermission("finance.manage");
    const file = await readStatementFile(request);
    if ("error" in file) return statementErrorResponse(file.error, file.message, requestId, 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("import_picpay_statement", {
      p_file_name: query.data.fileName, p_content: file.content, p_accept_overlap: query.data.acceptOverlap === "true",
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return statementDatabaseError(error.message, requestId);
    const row = databaseImportSchema.safeParse(data);
    if (!row.success) return statementErrorResponse("STATEMENT_UNAVAILABLE", "Importação temporariamente indisponível.", requestId, 503);
    return NextResponse.json(picpayStatementImportResponseSchema.parse({ data: toImport(row.data), request_id: requestId }),
      { status: 201, headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return statementErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return statementErrorResponse("STATEMENT_UNAVAILABLE", "Importação temporariamente indisponível.", requestId, 503);
  }
}
