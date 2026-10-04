import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const cents = z.number().int();

// ADMIN-001 (spec 5.1 e 5.9): period indicators derived from the ledgers.
export const managementIndicatorsQuerySchema = z.object({ from: isoDate, to: isoDate }).strict()
  .refine((value) => value.from <= value.to, { message: "O início precisa ser anterior ao fim", path: ["to"] });

export const managementIndicatorsSchema = z.object({
  period: z.object({ from: isoDate, to: isoDate, days: z.number().int().positive(), timeZone: z.literal("America/Sao_Paulo") }).strict(),
  totals: z.object({
    grossRevenueCents: cents, saleRevenueCents: cents, manualIncomeCents: cents, refundsCents: cents, feesCents: cents,
    divergencesCents: cents, netRevenueCents: cents, cogsCents: cents, cogsUnknownUnits: z.number().int(),
    lossesCostCents: cents, lossesUnits: z.number().int(), lossesUnknownUnits: z.number().int(),
    operatingExpensesCents: cents, supplierPaymentsCents: cents, grossMarginCents: cents, grossMarginBps: z.number().int().nullable(),
    operatingProfitCents: cents, cashBalanceCents: cents, salesCount: z.number().int(), refundedSales: z.number().int(),
    averageTicketCents: cents.nullable(), costComplete: z.boolean(),
  }).strict(),
  byChannel: z.object({ PDV: cents, ONLINE: cents, RESERVA: cents, RIFA: cents, EVENTO: cents, MANUAL: cents }).strict(),
  byPaymentMethod: z.record(z.string(), cents),
  refundsByPaymentMethod: z.record(z.string(), cents),
  expensesByCategory: z.record(z.string(), cents),
  topProducts: z.array(z.object({
    productId: z.uuid(), productName: z.string(), units: z.number().int(), revenueCents: cents, costCents: cents.nullable(),
    unknownCostUnits: z.number().int(), marginCents: cents.nullable(), unitsPerDay: z.number(),
  }).strict()),
  sellers: z.array(z.object({
    sellerId: z.uuid(), sellerName: z.string(), revenueCents: cents, salesCount: z.number().int(), refundedCount: z.number().int(),
    units: z.number().int(), averageTicketCents: cents.nullable(),
  }).strict()),
  losses: z.array(z.object({
    productId: z.uuid(), productName: z.string(), reason: z.string(), locationId: z.uuid(), locationName: z.string(),
    units: z.number().int(), costCents: cents.nullable(), unknownCostUnits: z.number().int(),
  }).strict()),
  daily: z.array(z.object({ day: isoDate, revenueCents: cents, netRevenueCents: cents, cogsCents: cents, grossMarginCents: cents }).strict()),
  pending: z.object({
    awaitingPayment: z.number().int(), divergentReconciliations: z.number().int(), reopenedCloseouts: z.number().int(),
    openPaymentRecoveries: z.number().int(), statementLinesPending: z.number().int(),
  }).strict(),
}).strict();
export type ManagementIndicators = z.infer<typeof managementIndicatorsSchema>;

export const managementIndicatorsResponseSchema = z.object({ data: managementIndicatorsSchema, request_id: z.string().min(1) }).strict();
