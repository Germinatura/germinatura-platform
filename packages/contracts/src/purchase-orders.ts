import { z } from "zod";

const cents = z.number().int().nonnegative().refine(Number.isSafeInteger);
const optionalNote = (max: number) => z.string().trim().min(4).max(max).nullable();

export const purchaseOrderItemInputSchema = z.object({
  productId: z.uuid(), quantity: z.number().int().positive().max(9007199254740991),
  unitCostCents: cents.refine((value) => value > 0),
}).strict();

export const createPurchaseOrderSchema = z.object({
  supplierId: z.uuid(), orderedOn: z.iso.date(), expectedOn: z.iso.date().nullable(),
  freightCents: cents, otherCostCents: cents, paymentMethod: z.string().trim().min(2).max(80),
  proofReference: optionalNote(500), notes: optionalNote(1000),
  items: z.array(purchaseOrderItemInputSchema).min(1).max(100),
  reason: z.string().trim().min(4).max(500),
}).strict().superRefine((order, context) => {
  if (order.expectedOn && order.expectedOn < order.orderedOn) context.addIssue({ code: "custom", path: ["expectedOn"], message: "Expected date precedes order" });
  if (new Set(order.items.map((item) => item.productId)).size !== order.items.length) context.addIssue({ code: "custom", path: ["items"], message: "Duplicate product" });
  const total = order.items.reduce((sum, item) => sum + item.quantity * item.unitCostCents, order.freightCents + order.otherCostCents);
  if (!Number.isSafeInteger(total)) context.addIssue({ code: "custom", path: ["items"], message: "Total exceeds safe cents" });
});

export const cancelPurchaseOrderSchema = z.object({ reason: z.string().trim().min(4).max(500) }).strict();
export const purchaseOrderQuerySchema = z.object({
  cursor: z.uuid().optional(), orderId: z.uuid().optional(),
  status: z.enum(["ALL", "OPEN", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"]).default("ALL"),
}).strict();

export const purchaseOrderSchema = z.object({
  id: z.uuid(), supplierId: z.uuid(), supplierName: z.string(), status: z.enum(["OPEN", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"]),
  orderedOn: z.iso.date(), expectedOn: z.iso.date().nullable(),
  freightCents: cents, otherCostCents: cents, itemsSubtotalCents: cents, totalCents: cents,
  paymentMethod: z.string(), proofReference: z.string().nullable(), notes: z.string().nullable(),
  cancellationReason: z.string().nullable(), createdAt: z.iso.datetime({ offset: true }),
  items: z.array(z.object({ id: z.uuid(), productId: z.uuid(), productName: z.string(), productSku: z.string(), tracksLots: z.boolean(), quantity: z.number().int().positive(), unitCostCents: cents, lineTotalCents: cents }).strict()),
}).strict();
export const purchaseOrdersResponseSchema = z.object({ data: z.array(purchaseOrderSchema), nextCursor: z.uuid().nullable(), request_id: z.string() }).strict();
export const purchaseOrderCommandResponseSchema = z.object({ data: z.object({ id: z.uuid(), status: z.enum(["OPEN", "CANCELLED"]), totalCents: cents.optional(), correlationId: z.uuid() }).strict(), request_id: z.string() }).strict();
export type PurchaseOrder = z.infer<typeof purchaseOrderSchema>;
export type CreatePurchaseOrder = z.infer<typeof createPurchaseOrderSchema>;
