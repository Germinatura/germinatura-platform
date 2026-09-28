import { z } from "zod";

// PAY-009: seller cash shift and physical cash payments, all values in integer cents.
const cents = z.number().int().nonnegative().refine(Number.isSafeInteger, "Money must be a safe integer");

export const sellerShiftSchema = z.object({
  shiftId: z.uuid(),
  status: z.enum(["OPEN", "CLOSED"]),
  locationId: z.uuid(),
  openedAt: z.iso.datetime({ offset: true }),
  closedAt: z.iso.datetime({ offset: true }).nullable(),
  openingCashCents: cents,
  cashSalesCount: z.number().int().nonnegative(),
  cashSalesTotalCents: cents,
  expectedCashCents: cents,
  countedCashCents: cents.nullable(),
  differenceCents: z.number().int().refine(Number.isSafeInteger).nullable(),
  justification: z.string().nullable(),
}).strict();
export type SellerShift = z.infer<typeof sellerShiftSchema>;

export const openSellerShiftRequestSchema = z.object({
  locationId: z.uuid(),
  openingCashCents: cents,
}).strict();

export const closeSellerShiftRequestSchema = z.object({
  countedCashCents: cents,
  justification: z.string().trim().min(8).max(500).nullable(),
}).strict();

export const sellerShiftResponseSchema = z.object({
  data: sellerShiftSchema.nullable(),
  request_id: z.string().min(1),
}).strict();

export const cashPaymentRequestSchema = z.object({
  tenderedCents: cents,
}).strict();

export const cashPaymentResponseSchema = z.object({
  data: z.object({
    saleId: z.uuid(),
    saleStatus: z.literal("CONFIRMED"),
    paymentAttempt: z.object({
      attemptId: z.uuid(),
      status: z.literal("APPROVED"),
      amountCents: cents,
      integrationChannel: z.literal("DINHEIRO"),
      confirmationSource: z.literal("MANUAL"),
      confirmedAt: z.iso.datetime({ offset: true }),
    }).strict(),
    cash: z.object({ shiftId: z.uuid(), tenderedCents: cents, changeCents: cents }).strict(),
    financialLedgerEntryId: z.uuid(),
    correlationId: z.uuid(),
  }).strict(),
  request_id: z.string().min(1),
}).strict();
export type CashPaymentResponse = z.infer<typeof cashPaymentResponseSchema>;
