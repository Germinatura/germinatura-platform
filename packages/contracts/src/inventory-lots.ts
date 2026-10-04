import { z } from "zod";

const quantity = z.number().int().nonnegative().refine(Number.isSafeInteger);
const cents = z.number().int().nonnegative().refine(Number.isSafeInteger);

export const inventoryLotQuerySchema = z.object({
  query: z.string().trim().min(1).max(100).optional(),
  lotId: z.uuid().optional(),
  positionCursor: z.string().regex(/^[0-9a-f-]{36}:[0-9a-f-]{36}$/i).optional(),
  historyCursor: z.uuid().optional(),
}).strict();

export const inventoryLotPositionSchema = z.object({
  lotId: z.uuid(), lotCode: z.string(), originType: z.enum(["PURCHASE_RECEIPT", "STOCK_MOVEMENT_ITEM", "TRACEABILITY_BASELINE"]),
  productId: z.uuid(), productSku: z.string(), productName: z.string(), locationId: z.uuid(), locationName: z.string(),
  onHandQuantity: quantity, manufacturedOn: z.iso.date().nullable(), expiresOn: z.iso.date().nullable(),
  receivedQuantity: quantity, totalCostCents: cents.nullable(), consumedQuantity: quantity,
  consumedCostCents: cents.nullable(), createdAt: z.iso.datetime({ offset: true }),
}).strict();

export const inventoryLotHistorySchema = z.object({
  id: z.uuid(), lotId: z.uuid(), quantity: quantity, allocatedCostCents: cents.nullable(), movementId: z.uuid(),
  movementType: z.string(), fromLocationId: z.uuid().nullable(), toLocationId: z.uuid().nullable(),
  sourceType: z.string().nullable(), sourceId: z.string().nullable(), reason: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
}).strict();

export const inventoryLotsResponseSchema = z.object({
  data: z.array(inventoryLotPositionSchema), history: z.array(inventoryLotHistorySchema),
  nextPositionCursor: z.string().nullable(), nextHistoryCursor: z.uuid().nullable(), request_id: z.string(),
}).strict();
export type InventoryLotsResponse = z.infer<typeof inventoryLotsResponseSchema>;
