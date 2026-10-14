import { z } from "zod";
import { financeCategorySchema } from "./finance-entries";

// PR E: historical finance and indicators. Money in integer cents; dates are São Paulo calendar days.

const cents = z.number().int().refine(Number.isSafeInteger, "Money must be a safe integer");
const count = z.number().int().nonnegative();
const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.iso.datetime({ offset: true });

/** Each adjustment corrects exactly one component of the operating result (no generic "other"). */
export const financeResultComponentSchema = z.enum(["RECEITA", "REEMBOLSO", "TAXA", "CMV", "PERDA", "DESPESA_OPERACIONAL"]);
export type FinanceResultComponent = z.infer<typeof financeResultComponentSchema>;
export const financeAdjustmentDirectionSchema = z.enum(["ACRESCIMO", "REDUCAO"]);
export const financeAdjustmentProvenanceSchema = z.enum(["HISTORICO_RECONSTRUIDO", "IMPORTADO", "IMPLANTACAO"]);

export const historicalAdjustmentMovementSchema = z.object({
  id: z.uuid(), movedOn: calendarDay, reason: z.string().nullable(), units: z.number().int(), knownCostCents: cents,
}).strict();
export const historicalAdjustmentSchema = z.object({
  id: z.uuid(),
  component: financeResultComponentSchema,
  direction: financeAdjustmentDirectionSchema,
  amountCents: cents,
  competenceOn: calendarDay,
  category: financeCategorySchema.nullable(),
  justification: z.string(),
  reference: z.string().nullable(),
  provenance: financeAdjustmentProvenanceSchema,
  /** Signed effect on the operating result; a reversal undoes its original. */
  resultEffectCents: cents,
  reversalOf: z.uuid().nullable(),
  reversalReason: z.string().nullable(),
  reversedBy: z.uuid().nullable(),
  stockMovements: z.array(historicalAdjustmentMovementSchema),
  actorName: z.string(),
  createdAt: timestamp,
}).strict();
export type HistoricalAdjustment = z.infer<typeof historicalAdjustmentSchema>;
export const adjustableMovementSchema = z.object({
  id: z.uuid(), movedOn: calendarDay, reason: z.string().nullable(), sourceType: z.string().nullable(), sourceId: z.string().nullable(),
  units: z.number().int(), knownCostCents: cents, unknownUnits: z.number().int(), coveredBy: z.uuid().nullable(),
}).strict();
export type AdjustableMovement = z.infer<typeof adjustableMovementSchema>;
export const historicalAdjustmentsResponseSchema = z.object({
  data: z.object({ items: z.array(historicalAdjustmentSchema), movements: z.array(adjustableMovementSchema), operatingSince: calendarDay.nullable() }).strict(),
  request_id: z.string().min(1),
}).strict();
export const recordHistoricalAdjustmentRequestSchema = z.object({
  component: financeResultComponentSchema,
  direction: financeAdjustmentDirectionSchema,
  amountCents: z.number().int().min(1).max(99_999_999_999),
  competenceOn: calendarDay,
  category: financeCategorySchema.nullable(),
  justification: z.string().trim().min(20).max(1000),
  reference: z.string().trim().min(1).max(120).nullable(),
  provenance: financeAdjustmentProvenanceSchema,
  stockMovementIds: z.array(z.uuid()).max(200),
}).strict().refine((value) => (value.component === "CMV" || value.component === "PERDA") && value.direction === "ACRESCIMO"
  ? value.stockMovementIds.length > 0 : value.stockMovementIds.length === 0, {
  message: "Um aumento de CMV ou perda indica os movimentos de estoque que reconhece; os demais ajustes não indicam movimentos",
  path: ["stockMovementIds"],
});
export type RecordHistoricalAdjustmentRequest = z.infer<typeof recordHistoricalAdjustmentRequestSchema>;
export const reverseHistoricalAdjustmentRequestSchema = z.object({ reason: z.string().trim().min(8).max(500) }).strict();
export const historicalAdjustmentResponseSchema = z.object({ data: historicalAdjustmentSchema, request_id: z.string().min(1) }).strict();

/** Cutover counterpart designation: presentation only (cash and official result never change). */
export const cutoverCounterpartSchema = z.object({
  id: z.uuid(),
  neutralizedCents: cents,
  reason: z.string(),
  status: z.enum(["ATIVA", "REVOGADA", "INVALIDA"]),
  counterpart: z.object({ id: z.uuid(), occurredOn: calendarDay, amountCents: cents, description: z.string(), reference: z.string().nullable(),
    category: financeCategorySchema.nullable() }).strict(),
  target: z.object({ kind: z.enum(["STATEMENT_LINE", "MANUAL_EXPENSE"]), id: z.uuid(), occurredOn: calendarDay, amountCents: cents,
    description: z.string().nullable(), reference: z.string().nullable(), category: financeCategorySchema.nullable() }).strict(),
  cashEffectCents: z.literal(0),
  resultEffectCents: z.literal(0),
  createdBy: z.string(),
  createdAt: timestamp,
  revocation: z.object({ reason: z.string(), revokedBy: z.string(), revokedAt: timestamp }).strict().nullable(),
  inWindow: z.boolean().optional(),
  counterpartInWindow: z.boolean().optional(),
  targetInWindow: z.boolean().optional(),
}).strict();
export type CutoverCounterpart = z.infer<typeof cutoverCounterpartSchema>;
export const counterpartCandidateSchema = z.object({
  id: z.uuid(), occurredOn: calendarDay, amountCents: cents, category: financeCategorySchema.nullable(), description: z.string(), reference: z.string().nullable(),
}).strict();
export const counterpartTargetCandidateSchema = z.object({
  kind: z.enum(["STATEMENT_LINE", "MANUAL_EXPENSE"]), id: z.uuid(), occurredOn: calendarDay, amountCents: cents, availableCents: cents,
  category: financeCategorySchema.nullable(), description: z.string().nullable(), reference: z.string().nullable(),
}).strict();
export const cutoverCounterpartsResponseSchema = z.object({
  data: z.object({
    operatingSince: calendarDay.nullable(),
    items: z.array(cutoverCounterpartSchema),
    counterpartCandidates: z.array(counterpartCandidateSchema),
    targetCandidates: z.array(counterpartTargetCandidateSchema),
  }).strict(),
  request_id: z.string().min(1),
}).strict();
export const designateCutoverCounterpartRequestSchema = z.object({
  counterpartManualEntryId: z.uuid(),
  targetStatementLineId: z.uuid().nullable(),
  targetManualExpenseId: z.uuid().nullable(),
  neutralizedCents: z.number().int().min(1).max(99_999_999_999),
  reason: z.string().trim().min(8).max(500),
}).strict().refine((value) => (value.targetStatementLineId === null) !== (value.targetManualExpenseId === null), {
  message: "Escolha exatamente uma despesa: linha do extrato ou lançamento manual", path: ["targetStatementLineId"],
});
export const revokeCutoverCounterpartRequestSchema = z.object({ reason: z.string().trim().min(8).max(500) }).strict();
export const cutoverCounterpartResponseSchema = z.object({ data: cutoverCounterpartSchema, request_id: z.string().min(1) }).strict();

const bridgeLineSchema = z.object({
  key: z.string(), label: z.string(), cents, status: z.enum(["CONFIRMADA", "ESTIMADA", "NAO_DETERMINAVEL"]),
  nature: z.enum(["NAO_DETERMINAVEL"]).optional(),
}).strict();

/** The financial overview: each figure keeps its meaning; presentation never changes the official result. */
export const financeOverviewSchema = z.object({
  period: z.object({ from: calendarDay, to: calendarDay, asOf: calendarDay, operatingSince: calendarDay.nullable() }).strict(),
  position: z.object({ freeCents: cents, vaultCents: cents, cashCents: cents, receivablesCents: cents, pixInTransitCents: cents }).strict(),
  payables: z.object({ openCents: cents, openCount: count }).strict(),
  result: z.object({
    officialCents: cents,
    registeredCents: cents,
    historicalAdjustmentsCents: cents,
    historicalCents: cents.nullable(),
    nativeCents: cents.nullable(),
    historicalAdjustments: z.record(financeResultComponentSchema, z.object({ resultEffectCents: cents, componentEffectCents: cents }).strict()),
    presentation: z.object({
      operatingRevenuePresentedCents: cents,
      technicalCutoverCounterpartsCents: cents,
      deductionsCents: cents,
      operatingExpensesRegisteredCents: cents,
      counterpartsCents: cents,
      operatingExpensesPresentedCents: cents,
      cogsCents: cents,
      lossesCents: cents,
      operatingResultCents: cents,
      counterpartsOutsideWindow: count,
      invalidDesignations: count,
    }).strict(),
    costVisibility: z.object({
      unitsKnownPositive: z.number().int(), unitsKnownZero: z.number().int(), unitsUnknown: z.number().int(), salesWithUnknownCost: count,
      unknownByOrigin: z.record(z.string(), z.number().int()), unitsEstimable: z.number().int(), unitsNotEstimable: z.number().int(),
      estimatedUnknownCostCents: cents, lossUnitsUnknown: z.number().int(), status: z.enum(["COMPLETO", "ESTIMADO", "INCOMPLETO"]),
    }).strict(),
  }).strict(),
  counterparts: z.array(cutoverCounterpartSchema),
  bridge: z.object({
    partA: z.object({ from: calendarDay, to: calendarDay, lines: z.array(bridgeLineSchema), calculatedCents: cents, positionCents: cents, residualCents: cents }).strict(),
    partB: z.object({
      from: calendarDay, to: calendarDay, baseVersion: z.number().int().nullable(), declaredVersion: z.number().int(), lines: z.array(bridgeLineSchema),
      declaredCents: cents, reconstructedCents: cents,
      accounts: z.array(z.object({ account: z.string(), baseCents: cents, movementsCents: cents, reconstructedCents: cents, declaredCents: cents,
        differenceCents: cents }).strict()).nullable(),
      counterparts: z.array(z.object({ id: z.uuid(), counterpartReference: z.string().nullable(), counterpartCents: cents, targetReference: z.string().nullable(),
        targetCents: cents, neutralizedCents: cents, reason: z.string() }).strict()),
    }).strict().nullable(),
  }).strict(),
}).strict();
export type FinanceOverview = z.infer<typeof financeOverviewSchema>;
export const financeOverviewResponseSchema = z.object({ data: financeOverviewSchema, request_id: z.string().min(1) }).strict();
