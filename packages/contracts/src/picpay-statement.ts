import { z } from "zod";
import { financeAccountSchema, financeCategorySchema } from "./finance-entries";

// Spec 5.8 (FIN-007): statements exported by PicPay Empresas, imported as CSV with preview and review.
export const picpayStatementMovementSchema = z.enum([
  "PIX_RECEBIDO", "PIX_ENVIADO", "PIX_ESTORNADO", "PIX_DEVOLVIDO", "RECEBIVEIS_VENDA", "COFRINHO_GUARDADO",
  "COFRINHO_RESGATADO", "DESCONHECIDO",
]);
export type PicpayStatementMovement = z.infer<typeof picpayStatementMovementSchema>;
export const picpayStatementLineStatusSchema = z.enum([
  "TRANSFERENCIA", "CONCILIADA_VENDA", "CONCILIADA_ESTORNO", "CLASSIFICADA", "VINCULADA", "JA_REGISTRADO", "PENDENTE_REVISAO",
  "PENDENTE_CLASSIFICACAO",
]);
export type PicpayStatementLineStatus = z.infer<typeof picpayStatementLineStatusSchema>;
export const picpayStatementErrorCodeSchema = z.enum([
  "EMPTY_FILE", "INVALID_ENCODING", "TOO_MANY_LINES", "INVALID_HEADER", "NO_LINES", "INVALID_FIELD_COUNT", "INVALID_DATE",
  "FUTURE_DATE", "INVALID_MOVEMENT", "INVALID_TYPE", "INVALID_AMOUNT", "ZERO_AMOUNT", "AMOUNT_SIGN_MISMATCH",
]);
export type PicpayStatementErrorCode = z.infer<typeof picpayStatementErrorCodeSchema>;

/** Largest accepted file, in bytes. */
export const picpayStatementMaxBytes = 2_000_000;

const cents = z.number().int().refine(Number.isSafeInteger, "Money must be a safe integer");
const count = z.number().int().nonnegative();
const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.iso.datetime({ offset: true });

export const picpayStatementFileNameSchema = z.string().trim().min(1).max(200);

export const picpayStatementPreviewSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: count,
  lineCount: count,
  errorCount: count,
  errors: z.array(z.object({ line: z.number().int().positive(), code: picpayStatementErrorCodeSchema }).strict()),
  periodFrom: calendarDay.nullable(),
  periodTo: calendarDay.nullable(),
  inflowCents: cents,
  outflowCents: cents,
  byMovement: z.array(z.object({ movement: picpayStatementMovementSchema, count, amountCents: cents }).strict()),
  plan: z.object({
    TRANSFERENCIA: count, CONCILIADA_VENDA: count, CONCILIADA_ESTORNO: count, PENDENTE_REVISAO: count, PENDENTE_CLASSIFICACAO: count,
  }).strict(),
  repeatedLines: count,
  alreadyImported: z.object({ number: z.number().int().positive(), createdAt: timestamp }).strict().nullable(),
  overlaps: z.array(z.object({ number: z.number().int().positive(), periodFrom: calendarDay, periodTo: calendarDay }).strict()),
}).strict();
export type PicpayStatementPreview = z.infer<typeof picpayStatementPreviewSchema>;

export const picpayStatementPreviewResponseSchema = z.object({
  data: picpayStatementPreviewSchema,
  request_id: z.string().min(1),
}).strict();

export const picpayStatementImportSchema = z.object({
  id: z.uuid(),
  number: z.number().int().positive(),
  account: financeAccountSchema,
  fileName: z.string(),
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
  fileSizeBytes: count,
  lineCount: count,
  periodFrom: calendarDay,
  periodTo: calendarDay,
  inflowCents: cents,
  outflowCents: cents,
  overlapAccepted: z.boolean(),
  actorName: z.string(),
  createdAt: timestamp,
  statusCounts: z.object({
    TRANSFERENCIA: count, CONCILIADA_VENDA: count, CONCILIADA_ESTORNO: count, CLASSIFICADA: count, VINCULADA: count, JA_REGISTRADO: count,
    PENDENTE_REVISAO: count, PENDENTE_CLASSIFICACAO: count,
  }).strict(),
}).strict();
export type PicpayStatementImport = z.infer<typeof picpayStatementImportSchema>;

export const picpayStatementImportResponseSchema = z.object({
  data: picpayStatementImportSchema,
  request_id: z.string().min(1),
}).strict();

export const picpayStatementImportsResponseSchema = z.object({
  data: z.array(picpayStatementImportSchema),
  nextBefore: z.number().int().positive().nullable(),
  pendingTotal: count,
  request_id: z.string().min(1),
}).strict();
export type PicpayStatementImportsResponse = z.infer<typeof picpayStatementImportsResponseSchema>;

export const picpayStatementImportQuerySchema = z.object({
  fileName: picpayStatementFileNameSchema,
  acceptOverlap: z.enum(["true", "false"]).optional(),
}).strict();

export const picpayStatementLinesQuerySchema = z.object({
  pending: z.enum(["true", "false"]).optional(),
  after: z.coerce.number().int().min(1).optional(),
}).strict();

export const picpayStatementLineSchema = z.object({
  id: z.uuid(),
  lineNumber: z.number().int().min(2),
  occurredOn: calendarDay,
  movement: picpayStatementMovementSchema,
  movementLabel: z.string(),
  amountCents: cents,
  description: z.string().nullable(),
  status: picpayStatementLineStatusSchema,
  resolution: z.object({
    resolution: z.enum(["TRANSFERENCIA", "CONCILIADA_VENDA", "CONCILIADA_ESTORNO", "CLASSIFICADA", "VINCULADA", "JA_REGISTRADO", "REABERTA"]),
    category: financeCategorySchema.nullable(),
    counterAccount: financeAccountSchema.nullable(),
    paymentAttemptId: z.uuid().nullable(),
    saleId: z.uuid().nullable(),
    refundEntryId: z.uuid().nullable(),
    refundSaleId: z.uuid().nullable(),
    reason: z.string().nullable(),
    automatic: z.boolean(),
    actorName: z.string(),
    createdAt: timestamp,
  }).strict().nullable(),
  saleCandidates: z.array(z.object({
    paymentAttemptId: z.uuid(), saleId: z.uuid(), amountCents: cents, channel: z.string(), approvedAt: timestamp, operatorName: z.string(),
  }).strict()),
  refundCandidates: z.array(z.object({
    refundEntryId: z.uuid(), saleId: z.uuid(), amountCents: cents, refundedAt: timestamp,
  }).strict()),
}).strict();
export type PicpayStatementLine = z.infer<typeof picpayStatementLineSchema>;

export const picpayStatementLinesResponseSchema = z.object({
  import: picpayStatementImportSchema,
  data: z.array(picpayStatementLineSchema),
  nextAfter: z.number().int().nullable(),
  request_id: z.string().min(1),
}).strict();
export type PicpayStatementLinesResponse = z.infer<typeof picpayStatementLinesResponseSchema>;

const reason = z.string().trim().min(8).max(300);
export const resolvePicpayStatementLineRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("CONCILIAR_VENDA"), paymentAttemptId: z.uuid() }).strict(),
  z.object({ action: z.literal("CONCILIAR_ESTORNO"), refundEntryId: z.uuid() }).strict(),
  z.object({
    action: z.literal("CLASSIFICAR"),
    category: financeCategorySchema.refine((value) => !["VENDA_PDV", "VENDA_ONLINE", "RESERVA", "RIFA"].includes(value),
      "Receita de vendas vem só das vendas registradas"),
    note: z.string().trim().min(3).max(300).optional(),
  }).strict(),
  z.object({ action: z.literal("JA_REGISTRADO"), reason }).strict(),
  z.object({ action: z.literal("REABRIR"), reason }).strict(),
]);
export type ResolvePicpayStatementLineRequest = z.infer<typeof resolvePicpayStatementLineRequestSchema>;

export const picpayStatementResolutionResponseSchema = z.object({
  data: z.object({
    lineId: z.uuid(),
    resolution: z.enum(["CONCILIADA_VENDA", "CONCILIADA_ESTORNO", "CLASSIFICADA", "JA_REGISTRADO", "REABERTA"]),
    category: financeCategorySchema.nullable(),
  }).strict(),
  request_id: z.string().min(1),
}).strict();
