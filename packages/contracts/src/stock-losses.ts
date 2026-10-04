import { z } from "zod";

const quantitySchema = z.number().int().positive().refine(Number.isSafeInteger);
export const stockLossReasonSchema = z.enum(["DAMAGED", "EXPIRED", "MISSING", "AUTHORIZED_CONSUMPTION", "OPERATIONAL_ERROR", "OTHER"]);
export const stockLossStatusSchema = z.enum(["PENDING_APPROVAL", "APPLIED", "REJECTED", "CANCELLED"]);
export const stockLossQuerySchema = z.object({ cursor: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();
export const reportStockLossSchema = z.object({ productId: z.uuid(), quantity: quantitySchema, reason: stockLossReasonSchema, observation: z.string().trim().min(4).max(500), photoPath: z.string().trim().min(1).max(500).nullable().optional() }).strict();
export const resolveStockLossSchema = z.object({ action: z.enum(["APPROVE", "REJECT", "CANCEL"]), reason: z.string().trim().min(4).max(500) }).strict();
export const updateStockLossSettingsSchema = z.object({ approvalThresholdQuantity: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(), reason: z.string().trim().min(4).max(500) }).strict();
export const stockLossOptionSchema = z.object({ productId: z.uuid(), productName: z.string().min(1), productSku: z.string().min(1), availableQuantity: z.number().int().nonnegative().refine(Number.isSafeInteger) }).strict();
export const stockLossSchema = z.object({
  id: z.uuid(), locationId: z.uuid(), locationName: z.string().min(1), productId: z.uuid(), productName: z.string().min(1), productSku: z.string().min(1), quantity: quantitySchema,
  reason: stockLossReasonSchema, observation: z.string().min(4).max(500), photoPath: z.string().nullable(), photoUrl: z.url().nullable(), status: stockLossStatusSchema,
  reportedBy: z.uuid(), decisionReason: z.string().min(4).max(500).nullable(), movementId: z.uuid().nullable(), createdAt: z.iso.datetime({ offset: true }), decidedAt: z.iso.datetime({ offset: true }).nullable(),
}).strict();
export const stockLossContextResponseSchema = z.object({ data: z.object({ ownLocationId: z.uuid().nullable(), approvalThresholdQuantity: z.number().int().nonnegative().nullable(), options: z.array(stockLossOptionSchema), reports: z.array(stockLossSchema), nextCursor: z.uuid().nullable() }).strict(), request_id: z.string().min(1) }).strict();
export const stockLossMutationResponseSchema = z.object({ data: z.object({ reportId: z.uuid(), status: stockLossStatusSchema, movementId: z.uuid().nullable().optional(), correlationId: z.uuid() }).strict(), request_id: z.string().min(1) }).strict();
export const stockLossSettingsResponseSchema = z.object({ data: z.object({ approvalThresholdQuantity: z.number().int().nonnegative().nullable(), updatedAt: z.iso.datetime({ offset: true }).nullable() }).strict(), request_id: z.string().min(1) }).strict();
export type StockLossContextResponse = z.infer<typeof stockLossContextResponseSchema>;
export type StockLossMutationResponse = z.infer<typeof stockLossMutationResponseSchema>;
