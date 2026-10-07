import { z } from "zod";

// Spec 5.8 (FIN-001, FIN-002, FIN-003, FIN-007): PicPay reconciliation across the three exports of PicPay Empresas.
// Commercial truth: the Germinatura sale. Acquirer: Minhas vendas. Money still to be paid: Recebíveis. Treasury: Extrato.

const cents = z.number().int().refine(Number.isSafeInteger, "Money must be a safe integer");
const count = z.number().int().nonnegative();
const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.iso.datetime({ offset: true });

export const picpaySourceTypeSchema = z.enum(["PICPAY_SALES", "PICPAY_RECEIVABLES", "PICPAY_STATEMENT"]);
export type PicpaySourceType = z.infer<typeof picpaySourceTypeSchema>;
export const picpayTransactionStatusSchema = z.enum(["APROVADA", "NEGADA", "DEVOLVIDA", "OUTRO"]);
export type PicpayTransactionStatus = z.infer<typeof picpayTransactionStatusSchema>;
export const picpayExceptionTypeSchema = z.enum([
  "PDV_SEM_PICPAY", "PICPAY_SEM_PDV", "VALOR_DIVERGENTE", "METODO_DIVERGENTE", "TRANSACAO_DEVOLVIDA", "STATUS_DIVERGENTE",
  "LIQUIDACAO_SEM_EXPLICACAO", "RECEBIVEL_EM_ATRASO", "RECEBIVEL_INCONSISTENTE", "DUPLICIDADE", "EXTRATO_NAO_CLASSIFICADO",
  "RECEITA_DUPLICADA", "LIQUIDACAO_DUPLICADA", "SALDO_DIVERGENTE",
]);
export type PicpayExceptionType = z.infer<typeof picpayExceptionTypeSchema>;

/** Largest accepted PicPay export, in bytes. */
export const picpayFileMaxBytes = 4_000_000;

export const picpayFilePreviewSchema = z.object({
  sourceType: picpaySourceTypeSchema.nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: count,
  rowCount: count,
  errorCount: count,
  errors: z.array(z.object({ line: z.number().int().positive(), code: z.string() }).strict()),
  periodFrom: calendarDay.nullable(),
  periodTo: calendarDay.nullable(),
  newCount: count,
  knownCount: count,
  updatedCount: count,
  ambiguousCount: count,
  alreadyImported: z.object({ number: z.number().int().positive(), createdAt: timestamp }).strict().nullable(),
  totals: z.record(z.string(), cents),
}).strict();
export type PicpayFilePreview = z.infer<typeof picpayFilePreviewSchema>;
export const picpayFilePreviewResponseSchema = z.object({ data: picpayFilePreviewSchema, request_id: z.string().min(1) }).strict();

export const picpayImportSchema = z.object({
  id: z.uuid(),
  sourceType: picpaySourceTypeSchema,
  number: z.number().int().positive(),
  fileName: z.string(),
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
  rowCount: count,
  periodFrom: calendarDay,
  periodTo: calendarDay,
  newCount: count,
  knownCount: count,
  updatedCount: count,
  ambiguousCount: count,
  actorName: z.string(),
  createdAt: timestamp,
}).strict();
export type PicpayImport = z.infer<typeof picpayImportSchema>;
export const picpayImportResponseSchema = z.object({
  data: picpayImportSchema.extend({
    reconciliation: z.object({ links: count, pix: count, refunds: count, settlements: count }).strict(),
    periodsFlagged: count,
  }).strict(),
  request_id: z.string().min(1),
}).strict();
export const picpayImportsResponseSchema = z.object({ data: z.array(picpayImportSchema), request_id: z.string().min(1) }).strict();

export const picpayPeriodQuerySchema = z.object({ from: calendarDay, to: calendarDay }).strict()
  .refine((value) => value.from <= value.to, { message: "Período inválido", path: ["to"] });

export const picpaySummarySchema = z.object({
  period: z.object({ from: calendarDay, to: calendarDay }).strict(),
  operatingSince: calendarDay.nullable(),
  pdvSales: count,
  picpay: z.object({
    transactions: count, approved: count, denied: count, refunded: count, historical: count, linked: count,
    grossCents: cents, feeCents: cents, netCents: cents,
  }).strict(),
  exceptions: z.object({ total: count, byType: z.record(z.string(), count) }).strict(),
  receivables: z.object({ pendingCents: cents, overdueCents: cents, snapshotCents: cents, settledCents: cents }).strict(),
  statement: z.object({ lines: count, inflowCents: cents, outflowCents: cents, internalTransferCents: cents, pendingLines: count }).strict(),
  balances: z.object({
    asOf: calendarDay, freeBalanceCents: cents, vaultBalanceCents: cents, availableBalanceCents: cents, receivablesBalanceCents: cents,
    pixClearingCents: cents, cashBalanceCents: cents,
  }).strict(),
  status: z.enum(["CONCILIADO", "COM_PENDENCIAS"]),
}).strict();
export type PicpaySummary = z.infer<typeof picpaySummarySchema>;
export const picpaySummaryResponseSchema = z.object({ data: picpaySummarySchema, request_id: z.string().min(1) }).strict();

export const picpayExceptionsQuerySchema = z.object({
  from: calendarDay, to: calendarDay, type: picpayExceptionTypeSchema.optional(), resolved: z.enum(["true", "false"]).optional(),
}).strict().refine((value) => value.from <= value.to, { message: "Período inválido", path: ["to"] });
export const picpayExceptionSchema = z.object({
  key: z.string(),
  type: picpayExceptionTypeSchema,
  occurredOn: calendarDay,
  amountCents: cents,
  subjectType: z.string(),
  subjectId: z.uuid().nullable(),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  resolved: z.boolean(),
  resolutionReason: z.string().nullable(),
  resolvedAt: timestamp.nullable(),
}).strict();
export type PicpayException = z.infer<typeof picpayExceptionSchema>;
export const picpayExceptionsResponseSchema = z.object({ data: z.array(picpayExceptionSchema), request_id: z.string().min(1) }).strict();
export const resolvePicpayExceptionRequestSchema = z.object({
  key: z.string().min(3).max(200),
  action: z.enum(["RESOLVIDA", "REABERTA"]),
  reason: z.string().trim().min(8).max(300),
}).strict();
export type ResolvePicpayExceptionRequest = z.infer<typeof resolvePicpayExceptionRequestSchema>;

export const picpayTransactionsQuerySchema = z.object({
  from: calendarDay, to: calendarDay, status: picpayTransactionStatusSchema.optional(), unlinked: z.enum(["true", "false"]).optional(),
}).strict().refine((value) => value.from <= value.to, { message: "Período inválido", path: ["to"] });
export const picpayTransactionSchema = z.object({
  id: z.uuid(),
  transactionRef: z.string(),
  soldAt: timestamp,
  expectedPaymentOn: calendarDay.nullable(),
  method: z.string(),
  kind: z.enum(["PIX", "CREDITO", "DEBITO", "PICPAY", "OUTRO"]),
  capture: z.string().nullable(),
  terminal: z.string().nullable(),
  brand: z.string().nullable(),
  cardLast4: z.string().nullable(),
  status: picpayTransactionStatusSchema,
  grossCents: cents,
  feeCents: cents,
  netCents: cents,
  cancelledCents: cents,
  installments: z.number().int().positive(),
  historical: z.boolean(),
  paymentAttemptId: z.uuid().nullable(),
  linkEvidence: z.enum(["REFERENCIA", "VALOR_HORARIO_METODO", "MANUAL"]).nullable(),
  observations: count,
  imports: z.array(z.number().int().positive()),
}).strict();
export type PicpayTransaction = z.infer<typeof picpayTransactionSchema>;
export const picpayTransactionsResponseSchema = z.object({ data: z.array(picpayTransactionSchema), request_id: z.string().min(1) }).strict();
export const linkPicpayTransactionRequestSchema = z.object({
  paymentAttemptId: z.uuid().nullable(),
  reason: z.string().trim().min(8).max(300),
}).strict();

export const picpaySettlementStatusSchema = z.enum(["LIQUIDADO", "PARCIAL", "EXCEDENTE", "EM_ATRASO", "A_RECEBER"]);
export const picpaySettlementsResponseSchema = z.object({
  data: z.object({
    days: z.array(z.object({
      paymentOn: calendarDay, expectedNetCents: cents, expectedCount: count, settledCents: cents, settledLines: count,
      receivableSnapshotCents: cents, statementCovered: z.boolean(), status: picpaySettlementStatusSchema,
    }).strict()),
    receivables: z.array(z.object({
      id: z.uuid(), transactionRef: z.string(), installment: z.number().int().positive(), installmentsTotal: z.number().int().positive(),
      paymentOn: calendarDay, status: z.string(), grossCents: cents, discountCents: cents, netCents: cents, terminal: z.string().nullable(),
      snapshots: count, lastSnapshot: z.number().int().positive(),
    }).strict()),
  }).strict(),
  request_id: z.string().min(1),
}).strict();
export type PicpaySettlements = z.infer<typeof picpaySettlementsResponseSchema>["data"];

export const closePicpayPeriodRequestSchema = z.object({
  from: calendarDay, to: calendarDay, note: z.string().trim().min(3).max(300).nullable(),
}).strict().refine((value) => value.from <= value.to, { message: "Período inválido", path: ["to"] });
export const picpayPeriodSchema = z.object({
  id: z.uuid(), number: z.number().int().positive(), periodFrom: calendarDay, periodTo: calendarDay, note: z.string().nullable(),
  status: z.enum(["CONCILIADO", "COM_PENDENCIAS", "REVISAR"]), openExceptions: count, statusReason: z.string(), statusAt: timestamp,
  actorName: z.string(), createdAt: timestamp,
}).strict();
export type PicpayPeriod = z.infer<typeof picpayPeriodSchema>;
export const picpayPeriodsResponseSchema = z.object({ data: z.array(picpayPeriodSchema), request_id: z.string().min(1) }).strict();
