import { z } from "zod";

const cents = z.number().int().nonnegative().refine(Number.isSafeInteger);
const positiveCents = z.number().int().positive().refine(Number.isSafeInteger);

export const purchasePayableStatusSchema = z.enum(["PENDING", "SETTLED"]);
export const purchasePayableEntryTypeSchema = z.enum(["SETTLEMENT", "REVERSAL"]);

export const purchasePayableQuerySchema = z.object({
  status: z.enum(["ALL", "PENDING", "SETTLED"]).default("PENDING"),
  query: z.string().trim().max(160).optional(),
  cursor: z.uuid().optional(),
}).strict();

export const settlePurchasePayableSchema = z.object({
  amountCents: positiveCents,
  effectiveOn: z.iso.date(),
  paymentMethod: z.string().trim().min(2).max(100),
  reference: z.string().trim().min(2).max(160),
  reason: z.string().trim().min(4).max(500),
}).strict();

export const reversePurchasePayableSettlementSchema = z.object({
  effectiveOn: z.iso.date(),
  reason: z.string().trim().min(4).max(500),
}).strict();

export const purchasePayableSettlementSchema = z.object({
  id: z.uuid(),
  payableId: z.uuid(),
  entryType: purchasePayableEntryTypeSchema,
  amountCents: positiveCents,
  effectiveOn: z.iso.date(),
  paymentMethod: z.string(),
  reference: z.string(),
  reversalOf: z.uuid().nullable(),
  reason: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
}).strict();

export const purchasePayableSchema = z.object({
  id: z.uuid(),
  receiptId: z.uuid(),
  supplierId: z.uuid(),
  supplierName: z.string().min(1),
  amountCents: positiveCents,
  expectedPaymentMethod: z.string().min(1),
  settledCents: cents,
  outstandingCents: cents,
  status: purchasePayableStatusSchema,
  createdAt: z.iso.datetime({ offset: true }),
  settlements: z.array(purchasePayableSettlementSchema),
}).strict();

export const purchasePayablesResponseSchema = z.object({
  data: z.array(purchasePayableSchema),
  nextCursor: z.uuid().nullable(),
  request_id: z.string().min(1),
}).strict();

export const purchasePayableCommandResponseSchema = z.object({
  data: z.object({
    id: z.uuid(),
    payableId: z.uuid(),
    reversalOf: z.uuid().optional(),
    amountCents: positiveCents,
    remainingCents: cents,
    status: purchasePayableStatusSchema,
    correlationId: z.uuid(),
  }).strict(),
  request_id: z.string().min(1),
}).strict();

export type PurchasePayable = z.infer<typeof purchasePayableSchema>;
export type PurchasePayableSettlement = z.infer<typeof purchasePayableSettlementSchema>;
