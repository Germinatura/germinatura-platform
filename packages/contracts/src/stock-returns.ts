import { z } from "zod";

const quantitySchema = z.number().int().positive().refine(Number.isSafeInteger);
export const stockReturnStatusSchema = z.enum(["REQUESTED", "RECEIVED", "REJECTED", "CANCELLED"]);
export const stockReturnQuerySchema = z.object({ cursor: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();
export const requestStockReturnSchema = z.object({ productId: z.uuid(), quantity: quantitySchema, reason: z.string().trim().min(4).max(500) }).strict();
export const resolveStockReturnSchema = z.object({ action: z.enum(["RECEIVE", "REJECT", "CANCEL"]), reason: z.string().trim().min(4).max(500) }).strict();
export const stockReturnOptionSchema = z.object({ productId: z.uuid(), productName: z.string().min(1), productSku: z.string().min(1), availableQuantity: z.number().int().nonnegative().refine(Number.isSafeInteger) }).strict();
export const stockReturnSchema = z.object({
  id: z.uuid(), fromLocationId: z.uuid(), fromLocationName: z.string().min(1), toLocationId: z.uuid(), toLocationName: z.string().min(1),
  productId: z.uuid(), productName: z.string().min(1), productSku: z.string().min(1), quantity: quantitySchema,
  status: stockReturnStatusSchema, requestedBy: z.uuid(), requestReason: z.string().min(4).max(500), decisionReason: z.string().min(4).max(500).nullable(),
  movementId: z.uuid().nullable(), createdAt: z.iso.datetime({ offset: true }), decidedAt: z.iso.datetime({ offset: true }).nullable(),
}).strict();
export const stockReturnContextResponseSchema = z.object({ data: z.object({ ownLocationId: z.uuid().nullable(), options: z.array(stockReturnOptionSchema), requests: z.array(stockReturnSchema), nextCursor: z.uuid().nullable() }).strict(), request_id: z.string().min(1) }).strict();
export const stockReturnMutationResponseSchema = z.object({ data: z.object({ requestId: z.uuid(), status: stockReturnStatusSchema, movementId: z.uuid().nullable().optional(), correlationId: z.uuid() }).strict(), request_id: z.string().min(1) }).strict();
export type StockReturnContextResponse = z.infer<typeof stockReturnContextResponseSchema>;
export type StockReturnMutationResponse = z.infer<typeof stockReturnMutationResponseSchema>;
