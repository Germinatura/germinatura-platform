import { z } from "zod";

const cents = z.number().int().nonnegative().refine(Number.isSafeInteger);
const quantity = z.number().int().positive().refine(Number.isSafeInteger);

export const createPurchaseReceiptSchema = z.object({
  orderId: z.uuid(), orderItemId: z.uuid(), quantity,
  receivedOn: z.iso.date(), lotCode: z.string().trim().min(2).max(100).nullable(),
  manufacturedOn: z.iso.date().nullable(), expiresOn: z.iso.date().nullable(),
  reason: z.string().trim().min(4).max(500),
}).strict().superRefine((value, context) => {
  if (value.manufacturedOn && value.manufacturedOn > value.receivedOn) context.addIssue({ code: "custom", path: ["manufacturedOn"], message: "Manufacture cannot follow receipt" });
  if (value.expiresOn && value.expiresOn <= value.receivedOn) context.addIssue({ code: "custom", path: ["expiresOn"], message: "Expired lot cannot be received" });
  if (value.manufacturedOn && value.expiresOn && value.manufacturedOn >= value.expiresOn) context.addIssue({ code: "custom", path: ["expiresOn"], message: "Expiry must follow manufacture" });
});

export const purchaseReceiptQuerySchema = z.object({ orderId: z.uuid(), cursor: z.uuid().optional() }).strict();

export const purchaseReceiptCommandResponseSchema = z.object({
  data: z.object({ id: z.uuid(), orderId: z.uuid(), quantity,
    baseCostCents: cents, allocatedExtraCents: cents, totalCostCents: cents,
    lotId: z.uuid(), movementId: z.uuid(), payableId: z.uuid(), correlationId: z.uuid() }).strict(),
  request_id: z.string(),
}).strict();

export const purchaseReceiptSchema = z.object({
  id: z.uuid(), orderId: z.uuid(), orderItemId: z.uuid(), productId: z.uuid(),
  quantity, receivedOn: z.iso.date(), baseCostCents: cents, allocatedExtraCents: cents,
  totalCostCents: cents, movementId: z.uuid(), createdAt: z.iso.datetime({ offset: true }),
  lot: z.object({ id: z.uuid(), code: z.string(), manufacturedOn: z.iso.date().nullable(), expiresOn: z.iso.date().nullable() }).strict(),
  payableId: z.uuid(),
}).strict();
export const purchaseReceiptsResponseSchema = z.object({
  data: z.array(purchaseReceiptSchema), nextCursor: z.uuid().nullable(),
  progress: z.array(z.object({ orderItemId: z.uuid(), orderedQuantity: quantity, receivedQuantity: z.number().int().nonnegative() }).strict()),
  request_id: z.string(),
}).strict();
export type PurchaseReceipt = z.infer<typeof purchaseReceiptSchema>;
