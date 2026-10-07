import {
  createApiError, picpayStatementBulkPreviewSchema, picpayStatementImportSchema, picpayStatementLineSchema,
} from "@germinatura/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

const n = z.number().int();
const statusCounts = z.object({
  TRANSFERENCIA: n, CONCILIADA_VENDA: n, CONCILIADA_ESTORNO: n, CLASSIFICADA: n, VINCULADA: n, JA_REGISTRADO: n, PENDENTE_REVISAO: n,
  PENDENTE_CLASSIFICACAO: n,
});

// Shapes returned by picpay_statement_import_json and list_picpay_statement_lines.
export const databaseImportSchema = z.object({
  id: z.uuid(), number: n, account: z.string(), file_name: z.string(), file_sha256: z.string(), file_size_bytes: n, line_count: n,
  period_from: z.string(), period_to: z.string(), inflow_cents: n, outflow_cents: n, overlap_accepted: z.boolean(),
  actor_name: z.string(), created_at: z.string(), status_counts: statusCounts, cutover_lines: n,
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

export function toImport(value: z.infer<typeof databaseImportSchema>) {
  return picpayStatementImportSchema.parse({
    id: value.id, number: value.number, account: value.account, fileName: value.file_name, fileSha256: value.file_sha256,
    fileSizeBytes: value.file_size_bytes, lineCount: value.line_count, periodFrom: value.period_from, periodTo: value.period_to,
    inflowCents: value.inflow_cents, outflowCents: value.outflow_cents, overlapAccepted: value.overlap_accepted,
    actorName: value.actor_name, createdAt: value.created_at, statusCounts: value.status_counts, cutoverLines: value.cutover_lines,
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
    STATEMENT_LINE_IS_CUTOVER_HISTORY: "Linhas anteriores ao início da operação são histórico: classifique, vincule ou marque como já registrada.",
    STATEMENT_LINK_RECORD_NOT_LINKABLE: "Este registro já está vinculado a outra linha, foi revertido ou é anterior à abertura.",
    STATEMENT_BULK_SELECTION_CHANGED: "A seleção mudou desde a prévia. Gere a prévia de novo antes de confirmar.",
    STATEMENT_BULK_SELECTION_INELIGIBLE: "Há linhas na seleção que não aceitam esta categoria. Ajuste o filtro.",
    IDEMPOTENCY_CONFLICT: "A chave já foi usada com outro conteúdo.",
    IDEMPOTENCY_IN_PROGRESS: "A operação já está em processamento.",
  };
  const code = Object.keys(conflicts).find((key) => message.includes(key));
  if (code) return statementErrorResponse(code, conflicts[code], requestId, 409);
  if (message.includes("STATEMENT_INVALID")) return statementErrorResponse("STATEMENT_INVALID", "O arquivo tem linhas inválidas. Confira a prévia.", requestId, 422);
  if (message.includes("STATEMENT_IMPORT_NOT_FOUND") || message.includes("STATEMENT_LINE_NOT_FOUND")) {
    return statementErrorResponse("NOT_FOUND", "Importação não encontrada.", requestId, 404);
  }
  if (message.includes("STATEMENT_HISTORICAL_REVENUE_NOT_ALLOWED")) {
    return statementErrorResponse("STATEMENT_HISTORICAL_REVENUE_NOT_ALLOWED", "Receita histórica vale só para entradas anteriores ao início da operação.", requestId, 422);
  }
  if (message.includes("FINANCE_CATEGORY_AUTOMATIC_ONLY")) return statementErrorResponse("FINANCE_CATEGORY_AUTOMATIC_ONLY", "Receita de vendas vem só das vendas registradas.", requestId, 422);
  if (message.includes("FINANCE_MANAGE_REQUIRED")) return statementErrorResponse("FORBIDDEN", "Operação não autorizada.", requestId, 403);
  if (message.includes("INVALID_")) return statementErrorResponse("INVALID_REQUEST", "Confira os dados enviados.", requestId, 422);
  return statementErrorResponse("STATEMENT_UNAVAILABLE", "Importação de extrato temporariamente indisponível.", requestId, 503);
}

// Shape returned by preview_picpay_statement_bulk.
export const databaseBulkPreviewSchema = z.object({
  count: n, total_cents: n, inflow_cents: n, outflow_cents: n, period_from: z.string().nullable(), period_to: z.string().nullable(),
  selection_sha256: z.string(), by_movement: z.array(z.object({ movement: z.string(), count: n, amount_cents: n })),
  refusals: z.array(z.object({ code: z.string(), count: n })), category: z.string(), max_lines: n,
});

export function toBulkPreview(value: z.infer<typeof databaseBulkPreviewSchema>) {
  return picpayStatementBulkPreviewSchema.parse({
    count: value.count, totalCents: value.total_cents, inflowCents: value.inflow_cents, outflowCents: value.outflow_cents,
    periodFrom: value.period_from, periodTo: value.period_to, selectionSha256: value.selection_sha256,
    byMovement: value.by_movement.map((row) => ({ movement: row.movement, count: row.count, amountCents: row.amount_cents })),
    refusals: value.refusals, category: value.category, maxLines: value.max_lines,
  });
}
