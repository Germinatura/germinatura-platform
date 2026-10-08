import {
  createApiError, picpayExceptionSchema, picpayFileMaxBytes, picpayFilePreviewSchema, picpayImportSchema, picpayPeriodSchema,
  picpaySummarySchema, picpayTransactionSchema,
} from "@germinatura/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

const n = z.number().int();

// Shapes returned by the PicPay reconciliation functions (snake_case from the database).
export const databaseFilePreviewSchema = z.object({
  source_type: z.string().nullable(), sha256: z.string(), size_bytes: n, row_count: n, error_count: n,
  errors: z.array(z.object({ line: n, code: z.string() })), period_from: z.string().nullable(), period_to: z.string().nullable(),
  new_count: n, known_count: n, updated_count: n, ambiguous_count: n,
  already_imported: z.object({ number: n, created_at: z.string() }).nullable(), totals: z.record(z.string(), z.unknown()),
});

export function toFilePreview(value: z.infer<typeof databaseFilePreviewSchema>) {
  // Only the numeric totals are shown; nested breakdowns stay server-side.
  const totals = Object.fromEntries(Object.entries(value.totals).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  return picpayFilePreviewSchema.parse({
    sourceType: value.source_type, sha256: value.sha256, sizeBytes: value.size_bytes, rowCount: value.row_count, errorCount: value.error_count,
    errors: value.errors, periodFrom: value.period_from, periodTo: value.period_to, newCount: value.new_count, knownCount: value.known_count,
    updatedCount: value.updated_count, ambiguousCount: value.ambiguous_count,
    alreadyImported: value.already_imported ? { number: value.already_imported.number, createdAt: value.already_imported.created_at } : null,
    totals,
  });
}

export const databaseImportSchema = z.object({
  id: z.uuid(), source_type: z.string(), number: n, file_name: z.string(), file_sha256: z.string(), row_count: n,
  period_from: z.string(), period_to: z.string(), new_count: n, known_count: n, updated_count: n, ambiguous_count: n,
  actor_name: z.string(), created_at: z.string(),
});

export function toImport(value: z.infer<typeof databaseImportSchema>) {
  return picpayImportSchema.parse({
    id: value.id, sourceType: value.source_type, number: value.number, fileName: value.file_name, fileSha256: value.file_sha256,
    rowCount: value.row_count, periodFrom: value.period_from, periodTo: value.period_to, newCount: value.new_count,
    knownCount: value.known_count, updatedCount: value.updated_count, ambiguousCount: value.ambiguous_count,
    actorName: value.actor_name, createdAt: value.created_at,
  });
}

export const databaseSummarySchema = z.object({
  period: z.object({ from: z.string(), to: z.string() }), operating_since: z.string().nullable(), pdv_sales: n,
  opening_as_of: z.string().nullable(), imported_from: z.string().nullable(), imported_to: z.string().nullable(),
  picpay: z.object({ transactions: n, approved: n, denied: n, refunded: n, historical: n, linked: n, gross_cents: n, fee_cents: n, net_cents: n }),
  exceptions: z.object({
    total: n, by_type: z.record(z.string(), n), total_all: n, outside_period: n, first_open_on: z.string().nullable(), last_open_on: z.string().nullable(),
  }),
  receivables: z.object({ pending_cents: n, overdue_cents: n, snapshot_cents: n, settled_cents: n }),
  statement: z.object({
    lines: n, inflow_cents: n, outflow_cents: n, internal_transfer_cents: n, pending_lines: n, pending_lines_total: n,
    pending_net_cents_total: n, pending_outside_period: n,
  }),
  balance_check: z.object({ as_of: z.string(), status: z.string(), total_difference_cents: n }).nullable(),
  balances: z.object({
    as_of: z.string(), free_balance_cents: n, vault_balance_cents: n, available_balance_cents: n, receivables_balance_cents: n,
    pix_clearing_cents: n, cash_balance_cents: n,
  }),
  status: z.string(),
});

export function toSummary(value: z.infer<typeof databaseSummarySchema>) {
  return picpaySummarySchema.parse({
    period: value.period, operatingSince: value.operating_since, openingAsOf: value.opening_as_of, importedFrom: value.imported_from,
    importedTo: value.imported_to, pdvSales: value.pdv_sales,
    picpay: {
      transactions: value.picpay.transactions, approved: value.picpay.approved, denied: value.picpay.denied, refunded: value.picpay.refunded,
      historical: value.picpay.historical, linked: value.picpay.linked, grossCents: value.picpay.gross_cents, feeCents: value.picpay.fee_cents,
      netCents: value.picpay.net_cents,
    },
    exceptions: {
      total: value.exceptions.total, byType: value.exceptions.by_type, totalAll: value.exceptions.total_all,
      outsidePeriod: value.exceptions.outside_period, firstOpenOn: value.exceptions.first_open_on, lastOpenOn: value.exceptions.last_open_on,
    },
    receivables: {
      pendingCents: value.receivables.pending_cents, overdueCents: value.receivables.overdue_cents,
      snapshotCents: value.receivables.snapshot_cents, settledCents: value.receivables.settled_cents,
    },
    statement: {
      lines: value.statement.lines, inflowCents: value.statement.inflow_cents, outflowCents: value.statement.outflow_cents,
      internalTransferCents: value.statement.internal_transfer_cents, pendingLines: value.statement.pending_lines,
      pendingLinesTotal: value.statement.pending_lines_total, pendingNetCentsTotal: value.statement.pending_net_cents_total,
      pendingOutsidePeriod: value.statement.pending_outside_period,
    },
    balanceCheck: value.balance_check ? {
      asOf: value.balance_check.as_of, status: value.balance_check.status, totalDifferenceCents: value.balance_check.total_difference_cents,
    } : null,
    balances: {
      asOf: value.balances.as_of, freeBalanceCents: value.balances.free_balance_cents, vaultBalanceCents: value.balances.vault_balance_cents,
      availableBalanceCents: value.balances.available_balance_cents, receivablesBalanceCents: value.balances.receivables_balance_cents,
      pixClearingCents: value.balances.pix_clearing_cents, cashBalanceCents: value.balances.cash_balance_cents,
    },
    status: value.status,
  });
}

export const databaseExceptionSchema = z.object({
  key: z.string(), type: z.string(), occurred_on: z.string(), amount_cents: n, subject_type: z.string(), subject_id: z.uuid().nullable(),
  details: z.record(z.string(), z.unknown()), resolved: z.boolean(), resolution_reason: z.string().nullable(), resolved_at: z.string().nullable(),
});

export function toException(value: z.infer<typeof databaseExceptionSchema>) {
  const details = Object.fromEntries(Object.entries(value.details)
    .map(([key, entry]) => [key, typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" || entry === null ? entry : String(entry)]));
  return picpayExceptionSchema.parse({
    key: value.key, type: value.type, occurredOn: value.occurred_on, amountCents: value.amount_cents, subjectType: value.subject_type,
    subjectId: value.subject_id, details, resolved: value.resolved, resolutionReason: value.resolution_reason, resolvedAt: value.resolved_at,
  });
}

export const databaseTransactionSchema = z.object({
  id: z.uuid(), transaction_ref: z.string(), sold_at: z.string(), expected_payment_on: z.string().nullable(), method: z.string(), kind: z.string(),
  capture: z.string().nullable(), terminal: z.string().nullable(), brand: z.string().nullable(), card_last4: z.string().nullable(),
  status: z.string(), gross_cents: n, fee_cents: n, net_cents: n, cancelled_cents: n, installments: n, historical: z.boolean(),
  payment_attempt_id: z.uuid().nullable(), link_evidence: z.string().nullable(), observations: n, imports: z.array(n).nullable(),
});

export function toTransaction(value: z.infer<typeof databaseTransactionSchema>) {
  return picpayTransactionSchema.parse({
    id: value.id, transactionRef: value.transaction_ref, soldAt: value.sold_at, expectedPaymentOn: value.expected_payment_on, method: value.method,
    kind: value.kind, capture: value.capture, terminal: value.terminal, brand: value.brand, cardLast4: value.card_last4, status: value.status,
    grossCents: value.gross_cents, feeCents: value.fee_cents, netCents: value.net_cents, cancelledCents: value.cancelled_cents,
    installments: value.installments, historical: value.historical, paymentAttemptId: value.payment_attempt_id, linkEvidence: value.link_evidence,
    observations: value.observations, imports: value.imports ?? [],
  });
}

export const databasePeriodSchema = z.object({
  id: z.uuid(), number: n, period_from: z.string(), period_to: z.string(), note: z.string().nullable(), status: z.string(),
  open_exceptions: n, status_reason: z.string(), status_at: z.string(), actor_name: z.string(), created_at: z.string(),
});

export function toPeriod(value: z.infer<typeof databasePeriodSchema>) {
  return picpayPeriodSchema.parse({
    id: value.id, number: value.number, periodFrom: value.period_from, periodTo: value.period_to, note: value.note, status: value.status,
    openExceptions: value.open_exceptions, statusReason: value.status_reason, statusAt: value.status_at, actorName: value.actor_name,
    createdAt: value.created_at,
  });
}

export function picpayErrorResponse(code: string, message: string, requestId: string, status: number) {
  return NextResponse.json(createApiError(code, message, requestId), {
    status, headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}

/** Reads the uploaded export as raw UTF-8 bytes; the file is never logged nor stored as is. */
export async function readPicpayFile(request: Request): Promise<{ content: string } | { error: string; message: string }> {
  const bytes = new Uint8Array(await request.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (bytes.byteLength === 0) return { error: "EMPTY_FILE", message: "O arquivo está vazio." };
  if (bytes.byteLength > picpayFileMaxBytes) return { error: "FILE_TOO_LARGE", message: "O arquivo passa de 4 MB." };
  try {
    return { content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { error: "INVALID_ENCODING", message: "O arquivo não está em UTF-8. Exporte novamente do PicPay Empresas." };
  }
}

/** Maps database errors of the reconciliation commands to API responses. */
export function picpayDatabaseError(message: string, requestId: string) {
  const conflicts: Record<string, string> = {
    PICPAY_FILE_ALREADY_IMPORTED: "Arquivo já importado.",
    PICPAY_ALREADY_LINKED: "Esta transação ou este pagamento do PDV já está vinculado.",
    PICPAY_TRANSACTION_NOT_LINKED: "Esta transação não está vinculada.",
    PICPAY_PAYMENT_NOT_LINKABLE: "O pagamento do PDV não pode ser vinculado.",
    PICPAY_EXCEPTION_ALREADY_RESOLVIDA: "Esta pendência já foi resolvida.",
    PICPAY_EXCEPTION_ALREADY_REABERTA: "Esta pendência já está aberta.",
    PICPAY_EXCEPTION_REQUIRES_LINE_REVIEW: "Uma linha do Extrato se resolve revisando a linha: classifique, vincule ou marque como já registrada.",
    IDEMPOTENCY_CONFLICT: "A chave já foi usada com outro conteúdo.",
    IDEMPOTENCY_IN_PROGRESS: "A operação já está em processamento.",
  };
  const code = Object.keys(conflicts).find((key) => message.includes(key));
  if (code) return picpayErrorResponse(code, conflicts[code], requestId, 409);
  if (message.includes("PICPAY_FILE_UNKNOWN")) {
    return picpayErrorResponse("PICPAY_FILE_UNKNOWN", "Arquivo não reconhecido: envie Minhas vendas, Recebíveis ou Extrato exportados do PicPay Empresas.", requestId, 422);
  }
  if (message.includes("PICPAY_FILE_INVALID")) return picpayErrorResponse("PICPAY_FILE_INVALID", "O arquivo tem linhas inválidas. Confira a prévia.", requestId, 422);
  if (message.includes("PICPAY_TRANSACTION_NOT_FOUND") || message.includes("PICPAY_EXCEPTION_NOT_FOUND")) {
    return picpayErrorResponse("NOT_FOUND", "Registro não encontrado.", requestId, 404);
  }
  if (message.includes("FINANCE_MANAGE_REQUIRED")) return picpayErrorResponse("FORBIDDEN", "Operação não autorizada.", requestId, 403);
  if (message.includes("INVALID_")) return picpayErrorResponse("INVALID_REQUEST", "Confira os dados enviados.", requestId, 422);
  return picpayErrorResponse("PICPAY_UNAVAILABLE", "Conciliação PicPay temporariamente indisponível.", requestId, 503);
}
