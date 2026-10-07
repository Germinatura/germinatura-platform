import { z } from "zod";
import { financeAccountSchema } from "./finance-entries";

// Spec 5.8 (FIN-002, FIN-003): treasury balances, the cutover opening position and the balance check.
// Balance is where the money is on a day; revenue, expense and result are flows of a period.

const cents = z.number().int().refine(Number.isSafeInteger, "Money must be a safe integer");
const nonNegativeCents = cents.refine((value) => value >= 0, "O valor não pode ser negativo");
const count = z.number().int().nonnegative();
const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.iso.datetime({ offset: true });

export const financeBalancesQuerySchema = z.object({ asOf: calendarDay.optional() }).strict();

const unappliedLines = z.object({ count, netCents: cents }).strict();
export const financeBalancesSchema = z.object({
  asOf: calendarDay,
  opening: z.object({ id: z.uuid(), version: z.number().int().positive(), asOf: calendarDay, operatingSince: calendarDay }).strict().nullable(),
  accounts: z.array(z.object({
    account: financeAccountSchema, openingCents: cents, inflowCents: cents, outflowCents: cents,
    transferInCents: cents, transferOutCents: cents, balanceCents: cents,
  }).strict()),
  /** PicPay Empresas. */
  freeBalanceCents: cents,
  /** Cofrinho PicPay. */
  vaultBalanceCents: cents,
  /** Free plus Cofrinho: never receivables or physical cash. */
  availableBalanceCents: cents,
  receivablesBalanceCents: cents,
  cashBalanceCents: cents,
  negativeAccounts: z.array(financeAccountSchema),
  /** Imported statement lines without an effect of their own up to the day. */
  statementLines: z.object({ pending: unappliedLines, alreadyRecorded: unappliedLines, linked: unappliedLines }).strict(),
}).strict();
export type FinanceBalances = z.infer<typeof financeBalancesSchema>;
export const financeBalancesResponseSchema = z.object({ data: financeBalancesSchema, request_id: z.string().min(1) }).strict();

export const financeOpeningPositionSchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  asOf: calendarDay,
  operatingSince: calendarDay,
  description: z.string(),
  reason: z.string().nullable(),
  supersedesId: z.uuid().nullable(),
  accounts: z.object({ PICPAY_EMPRESAS: cents, COFRINHO_PICPAY: cents, RECEBIVEIS_PICPAY: cents, DINHEIRO_FISICO: cents }).strict(),
  actorName: z.string(),
  createdAt: timestamp,
}).strict();
export type FinanceOpeningPosition = z.infer<typeof financeOpeningPositionSchema>;
export const financeOpeningPositionResponseSchema = z.object({
  data: z.object({ current: financeOpeningPositionSchema.nullable(), versions: z.array(financeOpeningPositionSchema) }).strict(),
  request_id: z.string().min(1),
}).strict();
export type FinanceOpeningPositionResponse = z.infer<typeof financeOpeningPositionResponseSchema>;

/** First version without reason or supersedesId; a correction names the current version and a reason. */
export const recordFinanceOpeningPositionRequestSchema = z.object({
  asOf: calendarDay,
  operatingSince: calendarDay,
  freeCents: nonNegativeCents,
  vaultCents: nonNegativeCents,
  receivablesCents: nonNegativeCents,
  cashCents: nonNegativeCents,
  description: z.string().trim().min(3).max(300),
  reason: z.string().trim().min(8).max(300).nullable(),
  supersedesId: z.uuid().nullable(),
}).strict().superRefine((value, context) => {
  if (value.operatingSince <= value.asOf) {
    context.addIssue({ code: "custom", path: ["operatingSince"], message: "A operação no Germinatura começa depois da abertura" });
  }
  if ((value.supersedesId === null) !== (value.reason === null)) {
    context.addIssue({ code: "custom", path: ["reason"], message: "Uma correção precisa de motivo; a primeira abertura, não" });
  }
});
export type RecordFinanceOpeningPositionRequest = z.infer<typeof recordFinanceOpeningPositionRequestSchema>;
export const financeOpeningPositionRecordedResponseSchema = z.object({
  data: financeOpeningPositionSchema, request_id: z.string().min(1),
}).strict();

export const financeBalanceCheckStatusSchema = z.enum(["CONCILIADO", "DIVERGENTE"]);
export const financeBalanceCheckSchema = z.object({
  id: z.uuid(),
  number: z.number().int().positive(),
  asOf: calendarDay,
  openingPositionId: z.uuid().nullable(),
  observedFreeCents: cents,
  observedVaultCents: cents,
  observedTotalCents: cents,
  computedFreeCents: cents,
  computedVaultCents: cents,
  computedTotalCents: cents,
  computedReceivablesCents: cents,
  computedCashCents: cents,
  freeDifferenceCents: cents,
  vaultDifferenceCents: cents,
  totalDifferenceCents: cents,
  statementLines: z.object({ pending: unappliedLines, alreadyRecorded: unappliedLines, linked: unappliedLines }).strict(),
  status: financeBalanceCheckStatusSchema,
  note: z.string().nullable(),
  actorName: z.string(),
  createdAt: timestamp,
}).strict();
export type FinanceBalanceCheck = z.infer<typeof financeBalanceCheckSchema>;
export const recordFinanceBalanceCheckRequestSchema = z.object({
  asOf: calendarDay,
  observedFreeCents: nonNegativeCents,
  observedVaultCents: nonNegativeCents,
  note: z.string().trim().min(3).max(500).nullable(),
}).strict();
export type RecordFinanceBalanceCheckRequest = z.infer<typeof recordFinanceBalanceCheckRequestSchema>;
export const financeBalanceCheckResponseSchema = z.object({ data: financeBalanceCheckSchema, request_id: z.string().min(1) }).strict();
export const financeBalanceChecksResponseSchema = z.object({
  data: z.array(financeBalanceCheckSchema), nextBefore: z.number().int().positive().nullable(), request_id: z.string().min(1),
}).strict();
export type FinanceBalanceChecksResponse = z.infer<typeof financeBalanceChecksResponseSchema>;
