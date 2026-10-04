import { z } from "zod";

const quantity = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const signedQuantity = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);

export const inventoryCountStatusSchema = z.enum(["PENDING_APPROVAL", "APPLIED", "REJECTED", "CANCELLED"]);
export const inventoryCountQuerySchema = z.object({ locationId: z.uuid().optional(), cursor: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();
export const inventoryCountItemInputSchema = z.object({ productId: z.uuid(), expectedOnHandQuantity: quantity, expectedReservedQuantity: quantity, countedOnHandQuantity: quantity }).strict().refine((item) => item.expectedReservedQuantity <= item.expectedOnHandQuantity, { message: "Reserved stock cannot exceed physical stock" });
export const submitInventoryCountSchema = z.object({ locationId: z.uuid().nullable().optional(), observation: z.string().trim().min(4).max(500), items: z.array(inventoryCountItemInputSchema).min(1).max(200) }).strict().refine((value) => new Set(value.items.map((item) => item.productId)).size === value.items.length, { message: "Products must be unique" });
export const resolveInventoryCountSchema = z.object({ action: z.enum(["APPROVE", "REJECT", "CANCEL"]), reason: z.string().trim().min(4).max(500) }).strict();

const inventoryCountItemSchema = z.object({ productId: z.uuid(), productName: z.string().min(1), productSku: z.string().min(1), expectedOnHandQuantity: quantity, expectedReservedQuantity: quantity, countedOnHandQuantity: quantity, differenceQuantity: signedQuantity, movementId: z.uuid().nullable() }).strict();
const inventoryCountSchema = z.object({ id: z.uuid(), locationId: z.uuid(), locationName: z.string().min(1), status: inventoryCountStatusSchema, observation: z.string().min(4).max(500), submittedBy: z.uuid(), decisionReason: z.string().min(4).max(500).nullable(), createdAt: z.iso.datetime({ offset: true }), decidedAt: z.iso.datetime({ offset: true }).nullable(), items: z.array(inventoryCountItemSchema).min(1) }).strict();
const inventoryBalanceSchema = z.object({ productId: z.uuid(), productName: z.string().min(1), productSku: z.string().min(1), onHandQuantity: quantity, reservedQuantity: quantity, availableQuantity: quantity }).strict();
const inventoryMovementSchema = z.object({ id: z.uuid(), movementType: z.string().min(1), reason: z.string().min(1), createdAt: z.iso.datetime({ offset: true }), items: z.array(z.object({ productId: z.uuid(), productName: z.string().min(1), quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()).min(1) }).strict();

export const inventoryCountContextResponseSchema = z.object({ data: z.object({
  selectedLocationId: z.uuid(),
  locations: z.array(z.object({ id: z.uuid(), name: z.string().min(1), locationType: z.enum(["CENTRAL", "SELLER"]) }).strict()),
  balances: z.array(inventoryBalanceSchema), counts: z.array(inventoryCountSchema), movements: z.array(inventoryMovementSchema), nextCursor: z.uuid().nullable(),
}).strict(), request_id: z.string().min(1) }).strict();
export const inventoryCountMutationResponseSchema = z.object({ data: z.object({ countId: z.uuid(), status: inventoryCountStatusSchema, adjustmentCount: z.number().int().nonnegative().optional(), correlationId: z.uuid() }).strict(), request_id: z.string().min(1) }).strict();

export type InventoryCountContextResponse = z.infer<typeof inventoryCountContextResponseSchema>;
export type InventoryCountMutationResponse = z.infer<typeof inventoryCountMutationResponseSchema>;
