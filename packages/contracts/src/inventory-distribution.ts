import { z } from "zod";

const stockQuantitySchema = z.number()
  .int()
  .positive()
  .refine(Number.isSafeInteger, "Quantity must be a safe integer");

export const distributeStockSchema = z.object({
  fromLocationId: z.uuid(),
  toLocationId: z.uuid(),
  productId: z.uuid(),
  quantity: stockQuantitySchema,
  reason: z.string().trim().min(4).max(500),
}).strict().refine((value) => value.fromLocationId !== value.toLocationId, {
  message: "Origem e destino devem ser diferentes",
  path: ["toLocationId"],
});

export const distributeStockResponseSchema = z.object({
  data: z.object({
    movementId: z.uuid(),
    fromLocationId: z.uuid(),
    toLocationId: z.uuid(),
    productId: z.uuid(),
    quantity: stockQuantitySchema,
    fromOnHandQuantity: z.number().int().nonnegative().refine(Number.isSafeInteger),
    toOnHandQuantity: z.number().int().nonnegative().refine(Number.isSafeInteger),
    correlationId: z.uuid(),
  }).strict(),
  request_id: z.string().min(1),
}).strict();

export type DistributeStock = z.infer<typeof distributeStockSchema>;
export type DistributeStockResponse = z.infer<typeof distributeStockResponseSchema>;
