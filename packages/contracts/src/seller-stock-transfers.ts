import { z } from "zod";

const stockQuantitySchema = z.number().int().positive()
  .refine(Number.isSafeInteger, "Quantity must be a safe integer");

export const sellerStockTransferStatusSchema = z.enum(["REQUESTED", "ACCEPTED", "REJECTED", "CANCELLED"]);

export const sellerStockTransferQuerySchema = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

export const requestSellerStockTransferSchema = z.object({
  fromLocationId: z.uuid(),
  productId: z.uuid(),
  quantity: stockQuantitySchema,
  reason: z.string().trim().min(4).max(500),
}).strict();

export const resolveSellerStockTransferSchema = z.object({
  action: z.enum(["ACCEPT", "REJECT", "CANCEL"]),
  reason: z.string().trim().min(4).max(500),
}).strict();

export const sellerStockTransferOptionSchema = z.object({
  fromLocationId: z.uuid(), fromLocationName: z.string().min(1),
  productId: z.uuid(), productName: z.string().min(1), productSku: z.string().min(1),
  availableQuantity: z.number().int().nonnegative().refine(Number.isSafeInteger),
}).strict();

export const sellerStockTransferSchema = z.object({
  id: z.uuid(), fromLocationId: z.uuid(), fromLocationName: z.string().min(1),
  toLocationId: z.uuid(), toLocationName: z.string().min(1),
  productId: z.uuid(), productName: z.string().min(1), productSku: z.string().min(1),
  quantity: stockQuantitySchema, status: sellerStockTransferStatusSchema, requestedBy: z.uuid(),
  requestReason: z.string().min(4).max(500), decisionReason: z.string().min(4).max(500).nullable(),
  movementId: z.uuid().nullable(), createdAt: z.iso.datetime({ offset: true }),
  decidedAt: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export const sellerStockTransferContextResponseSchema = z.object({
  data: z.object({
    ownLocationId: z.uuid().nullable(), options: z.array(sellerStockTransferOptionSchema),
    requests: z.array(sellerStockTransferSchema), nextCursor: z.uuid().nullable(),
  }).strict(),
  request_id: z.string().min(1),
}).strict();

export const sellerStockTransferMutationResponseSchema = z.object({
  data: z.object({
    requestId: z.uuid(), status: sellerStockTransferStatusSchema,
    movementId: z.uuid().nullable().optional(), correlationId: z.uuid(),
  }).strict(),
  request_id: z.string().min(1),
}).strict();

export type SellerStockTransferContextResponse = z.infer<typeof sellerStockTransferContextResponseSchema>;
export type SellerStockTransferMutationResponse = z.infer<typeof sellerStockTransferMutationResponseSchema>;
export type RequestSellerStockTransfer = z.infer<typeof requestSellerStockTransferSchema>;
export type ResolveSellerStockTransfer = z.infer<typeof resolveSellerStockTransferSchema>;
