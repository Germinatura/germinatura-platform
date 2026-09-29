import { z } from "zod";

// Spec 5.8 (FIN-005): simplified category plan, treasury accounts and audited manual entries.
export const financeCategorySchema = z.enum([
  "VENDA_PDV", "VENDA_ONLINE", "RESERVA", "RIFA", "EVENTO", "FORNECEDOR", "TAXAS", "MENSALIDADES",
  "TRANSPORTE", "MATERIAIS", "REEMBOLSO", "AJUSTE", "OUTROS",
]);
export type FinanceCategory = z.infer<typeof financeCategorySchema>;
/** Sale, reservation and raffle revenue only comes from automatic financial events. */
export const automaticFinanceCategories: readonly FinanceCategory[] = ["VENDA_PDV", "VENDA_ONLINE", "RESERVA", "RIFA"];
export const financeAccountSchema = z.enum(["PICPAY_EMPRESAS", "DINHEIRO_FISICO", "RECEBIVEIS_PICPAY", "PENDENTE_LIQUIDACAO"]);
export type FinanceAccount = z.infer<typeof financeAccountSchema>;

const cents = z.number().int().refine(Number.isSafeInteger, "Money must be a safe integer");
const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nonSensitiveReference = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{3,127}$/)
  .refine((value) => !/[0-9]{12,}/.test(value), "A referência não pode conter dados de cartão");

export const recordFinanceEntryRequestSchema = z.object({
  kind: z.enum(["EXPENSE", "INCOME", "TRANSFER"]),
  category: financeCategorySchema.nullable(),
  account: financeAccountSchema,
  counterAccount: financeAccountSchema.nullable(),
  amountCents: cents.refine((value) => value > 0, "O valor precisa ser positivo"),
  occurredOn: calendarDay,
  description: z.string().trim().min(3).max(300),
  reference: nonSensitiveReference.nullable(),
}).strict().superRefine((value, context) => {
  if (value.kind === "TRANSFER") {
    if (value.category !== null) context.addIssue({ code: "custom", path: ["category"], message: "Transferência não tem categoria" });
    if (!value.counterAccount || value.counterAccount === value.account) {
      context.addIssue({ code: "custom", path: ["counterAccount"], message: "Escolha outra conta de destino" });
    }
  } else {
    if (!value.category) context.addIssue({ code: "custom", path: ["category"], message: "Escolha a categoria" });
    if (value.counterAccount !== null) context.addIssue({ code: "custom", path: ["counterAccount"], message: "Só transferências têm conta de destino" });
  }
  if (value.category && automaticFinanceCategories.includes(value.category)) {
    context.addIssue({ code: "custom", path: ["category"], message: "Esta receita vem só das vendas registradas" });
  }
});
export type RecordFinanceEntryRequest = z.infer<typeof recordFinanceEntryRequestSchema>;

export const reverseFinanceEntryRequestSchema = z.object({
  reason: z.string().trim().min(8).max(300),
}).strict();

export const financeEntrySchema = z.object({
  id: z.uuid(),
  kind: z.enum(["EXPENSE", "INCOME", "TRANSFER", "REVERSAL"]),
  category: financeCategorySchema.nullable(),
  account: financeAccountSchema,
  counterAccount: financeAccountSchema.nullable(),
  amountCents: cents,
  occurredOn: calendarDay,
  description: z.string(),
  reference: z.string().nullable(),
  reversalOf: z.uuid().nullable(),
  reversedBy: z.uuid().nullable(),
  actorName: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
}).strict();
export type FinanceEntry = z.infer<typeof financeEntrySchema>;

export const financeEntryResponseSchema = z.object({
  data: financeEntrySchema,
  request_id: z.string().min(1),
}).strict();

export const financeEntriesQuerySchema = z.object({
  from: calendarDay,
  to: calendarDay,
  category: financeCategorySchema.optional(),
  account: financeAccountSchema.optional(),
  cursor: z.uuid().optional(),
}).strict().refine((value) => value.from <= value.to, { message: "Período inválido", path: ["to"] });

export const financeEntriesResponseSchema = z.object({
  data: z.array(financeEntrySchema),
  nextCursor: z.uuid().nullable(),
  totals: z.object({
    inflowCents: cents,
    outflowCents: cents,
    byAccount: z.record(z.string(), cents),
    byCategory: z.record(z.string(), cents),
  }).strict(),
  request_id: z.string().min(1),
}).strict();
export type FinanceEntriesResponse = z.infer<typeof financeEntriesResponseSchema>;

// FIN-006: consolidated statement of automatic and manual entries (transfers have no category).
export const financeStatementQuerySchema = z.object({
  from: calendarDay,
  to: calendarDay,
  format: z.enum(["json", "csv"]).optional(),
}).strict().refine((value) => value.from <= value.to, { message: "Período inválido", path: ["to"] });

export const financeStatementRowSchema = z.object({
  occurredOn: calendarDay,
  source: z.enum(["SALE", "PAYABLE", "MANUAL"]),
  sourceId: z.uuid(),
  category: financeCategorySchema.nullable(),
  account: financeAccountSchema,
  amountCents: cents,
  description: z.string(),
  reference: z.string().nullable(),
}).strict();
export type FinanceStatementRow = z.infer<typeof financeStatementRowSchema>;

export const financeStatementResponseSchema = z.object({
  data: z.array(financeStatementRowSchema),
  totals: z.object({
    inflowCents: cents,
    outflowCents: cents,
    byAccount: z.record(z.string(), cents),
    byCategory: z.record(z.string(), cents),
  }).strict(),
  request_id: z.string().min(1),
}).strict();
export type FinanceStatementResponse = z.infer<typeof financeStatementResponseSchema>;
