import {
  createApiError, picpayStatementImportSchema, picpayStatementLineSchema, picpayStatementMaxBytes, picpayStatementPreviewSchema,
} from "@germinatura/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

const n = z.number().int();
const statusCounts = z.object({
  TRANSFERENCIA: n, CONCILIADA_VENDA: n, CONCILIADA_ESTORNO: n, CLASSIFICADA: n, JA_REGISTRADO: n, PENDENTE_REVISAO: n, PENDENTE_CLASSIFICACAO: n,
});

// Shapes returned by preview_picpay_statement, picpay_statement_import_json and list_picpay_statement_lines.
export const databasePreviewSchema = z.object({
  sha256: z.string(), size_bytes: n, line_count: n, error_count: n,
  errors: z.array(z.object({ line: n, code: z.string() })),
  period_from: z.string().nullable(), period_to: z.string().nullable(), inflow_cents: n, outflow_cents: n,
  by_movement: z.array(z.object({ movement: z.string(), count: n, amount_cents: n })),
  plan: z.object({ TRANSFERENCIA: n, CONCILIADA_VENDA: n, CONCILIADA_ESTORNO: n, PENDENTE_REVISAO: n, PENDENTE_CLASSIFICACAO: n }),
  repeated_lines: n,
  already_imported: z.object({ number: n, created_at: z.string() }).nullable(),
  overlaps: z.array(z.object({ number: n, period_from: z.string(), period_to: z.string() })),
});

export const databaseImportSchema = z.object({
  id: z.uuid(), number: n, account: z.string(), file_name: z.string(), file_sha256: z.string(), file_size_bytes: n, line_count: n,
  period_from: z.string(), period_to: z.string(), inflow_cents: n, outflow_cents: n, overlap_accepted: z.boolean(),
  actor_name: z.string(), created_at: z.string(), status_counts: statusCounts,
});

export const databaseLineSchema = z.object({
  id: z.uuid(), line_number: n, occurred_on: z.string(), movement: z.string(), movement_label: z.string(), amount_cents: n,
  description: z.string().nullable(), status: z.string(),
  resolution: z.object({
    resolution: z.string(), category: z.string().nullable(), counter_account: z.string().nullable(),
    payment_attempt_id: z.uuid().nullable(), sale_id: z.uuid().nullable(), refund_entry_id: z.uuid().nullable(),
    refund_sale_id: z.uuid().nullable(), reason: z.string().nullable(), automatic: z.boolean(), actor_name: z.string(), created_at: z.string(),
  }).nullable(),
  sale_candidates: z.array(z.object({
    payment_attempt_id: z.uuid(), sale_id: z.uuid(), amount_cents: n, channel: z.string(), approved_at: z.string(), operator_name: z.string(),
  })),
  refund_candidates: z.array(z.object({ refund_entry_id: z.uuid(), sale_id: z.uuid(), amount_cents: n, refunded_at: z.string() })),
});

export function toPreview(value: z.infer<typeof databasePreviewSchema>) {
  return picpayStatementPreviewSchema.parse({
    sha256: value.sha256, sizeBytes: value.size_bytes, lineCount: value.line_count, errorCount: value.error_count, errors: value.errors,
    periodFrom: value.period_from, periodTo: value.period_to, inflowCents: value.inflow_cents, outflowCents: value.outflow_cents,
    byMovement: value.by_movement.map((row) => ({ movement: row.movement, count: row.count, amountCents: row.amount_cents })),
    plan: value.plan, repeatedLines: value.repeated_lines,
    alreadyImported: value.already_imported ? { number: value.already_imported.number, createdAt: value.already_imported.created_at } : null,
    overlaps: value.overlaps.map((row) => ({ number: row.number, periodFrom: row.period_from, periodTo: row.period_to })),
  });
}

export function toImport(value: z.infer<typeof databaseImportSchema>) {
  return picpayStatementImportSchema.parse({
    id: value.id, number: value.number, account: value.account, fileName: value.file_name, fileSha256: value.file_sha256,
    fileSizeBytes: value.file_size_bytes, lineCount: value.line_count, periodFrom: value.period_from, periodTo: value.period_to,
    inflowCents: value.inflow_cents, outflowCents: value.outflow_cents, overlapAccepted: value.overlap_accepted,
    actorName: value.actor_name, createdAt: value.created_at, statusCounts: value.status_counts,
  });
}

export function toLine(value: z.infer<typeof databaseLineSchema>) {
  const resolution = value.resolution;
  return picpayStatementLineSchema.parse({
    id: value.id, lineNumber: value.line_number, occurredOn: value.occurred_on, movement: value.movement,
    movementLabel: value.movement_label, amountCents: value.amount_cents, description: value.description, status: value.status,
    resolution: resolution ? {
      resolution: resolution.resolution, category: resolution.category, counterAccount: resolution.counter_account,
      paymentAttemptId: resolution.payment_attempt_id, saleId: resolution.sale_id, refundEntryId: resolution.refund_entry_id,
      refundSaleId: resolution.refund_sale_id, reason: resolution.reason, automatic: resolution.automatic,
      actorName: resolution.actor_name, createdAt: resolution.created_at,
    } : null,
    saleCandidates: value.sale_candidates.map((candidate) => ({
      paymentAttemptId: candidate.payment_attempt_id, saleId: candidate.sale_id, amountCents: candidate.amount_cents,
      channel: candidate.channel, approvedAt: candidate.approved_at, operatorName: candidate.operator_name,
    })),
    refundCandidates: value.refund_candidates.map((candidate) => ({
      refundEntryId: candidate.refund_entry_id, saleId: candidate.sale_id, amountCents: candidate.amount_cents, refundedAt: candidate.refunded_at,
    })),
  });
}

export function statementErrorResponse(code: string, message: string, requestId: string, status: number) {
  return NextResponse.json(createApiError(code, message, requestId), {
    status, headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}

/**
 * Reads the uploaded file as raw bytes and accepts it only when it is valid UTF-8. The byte order mark is kept so
 * the database hashes exactly the bytes of the file.
 */
export async function readStatementFile(request: Request): Promise<{ content: string } | { error: string; message: string }> {
  const bytes = new Uint8Array(await request.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (bytes.byteLength === 0) return { error: "EMPTY_FILE", message: "O arquivo está vazio." };
  if (bytes.byteLength > picpayStatementMaxBytes) return { error: "FILE_TOO_LARGE", message: "O arquivo passa de 2 MB." };
  try {
    return { content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { error: "INVALID_ENCODING", message: "O arquivo não está em UTF-8. Exporte novamente o extrato do PicPay Empresas." };
  }
}

/** Maps database errors of the statement commands to API responses. */
export function statementDatabaseError(message: string, requestId: string) {
  const conflicts: Record<string, string> = {
    STATEMENT_ALREADY_IMPORTED: "Este arquivo já foi importado.",
    STATEMENT_PERIOD_OVERLAP: "O período do arquivo cruza uma importação anterior. Confirme para importar mesmo assim.",
    STATEMENT_LINE_ALREADY_RESOLVED: "Esta linha já foi revisada.",
    STATEMENT_LINE_NOT_REOPENABLE: "Esta linha não pode ser reaberta.",
    STATEMENT_LINE_ACTION_NOT_ALLOWED: "Esta ação não vale para este movimento.",
    STATEMENT_SALE_NOT_RECONCILABLE: "A venda escolhida não está aguardando conciliação.",
    STATEMENT_REFUND_NOT_LINKABLE: "O estorno escolhido já está vinculado ou não é do PicPay.",
    STATEMENT_AMOUNT_MISMATCH: "O valor da linha é diferente do valor interno.",
    IDEMPOTENCY_CONFLICT: "A chave já foi usada com outro conteúdo.",
    IDEMPOTENCY_IN_PROGRESS: "A operação já está em processamento.",
  };
  const code = Object.keys(conflicts).find((key) => message.includes(key));
  if (code) return statementErrorResponse(code, conflicts[code], requestId, 409);
  if (message.includes("STATEMENT_INVALID")) return statementErrorResponse("STATEMENT_INVALID", "O arquivo tem linhas inválidas. Confira a prévia.", requestId, 422);
  if (message.includes("STATEMENT_IMPORT_NOT_FOUND") || message.includes("STATEMENT_LINE_NOT_FOUND")) {
    return statementErrorResponse("NOT_FOUND", "Importação não encontrada.", requestId, 404);
  }
  if (message.includes("FINANCE_CATEGORY_AUTOMATIC_ONLY")) return statementErrorResponse("FINANCE_CATEGORY_AUTOMATIC_ONLY", "Receita de vendas vem só das vendas registradas.", requestId, 422);
  if (message.includes("FINANCE_MANAGE_REQUIRED")) return statementErrorResponse("FORBIDDEN", "Operação não autorizada.", requestId, 403);
  if (message.includes("INVALID_")) return statementErrorResponse("INVALID_REQUEST", "Confira os dados enviados.", requestId, 422);
  return statementErrorResponse("STATEMENT_UNAVAILABLE", "Importação de extrato temporariamente indisponível.", requestId, 503);
}
