import { moneyFromCents } from "@germinatura/domain";
import { z } from "zod";

const moneyCentsInputSchema = z.number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "Money cents must be a safe integer")
  .transform(moneyFromCents);

export const catalogProductPriceSchema = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  amountCents: moneyCentsInputSchema,
  validFrom: z.iso.datetime({ offset: true }),
  validTo: z.iso.datetime({ offset: true }).nullable(),
  createdBy: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});

export const setCatalogProductPriceSchema = z.object({
  productId: z.uuid(),
  expectedProductRevision: z.number().int().min(1).max(2147483647),
  amountCents: moneyCentsInputSchema,
  reason: z.string().trim().min(4).max(500),
}).strict();

export const setCatalogProductPriceResponseSchema = z.object({
  data: z.object({
    id: z.uuid(),
    productId: z.uuid(),
    amountCents: moneyCentsInputSchema,
    validFrom: z.iso.datetime({ offset: true }),
    validTo: z.iso.datetime({ offset: true }).nullable(),
    previousPriceId: z.uuid().nullable(),
    productRevision: z.number().int().min(1).max(2147483647),
    correlationId: z.uuid(),
  }),
  request_id: z.string().min(1),
});

export const catalogProductPriceHistoryQuerySchema = z.object({
  cursor: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const catalogProductPriceHistoryResponseSchema = z.object({
  data: z.array(catalogProductPriceSchema),
  nextCursor: z.iso.datetime({ offset: true }).nullable(),
  request_id: z.string().min(1),
});

export type CatalogProductPrice = z.infer<typeof catalogProductPriceSchema>;
