import { z } from "zod";

const productSlugSchema = z.string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const generatedProductSkuSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[A-Z0-9]+(?:[-_.][A-Z0-9]+)*$/);

export const catalogProductSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().min(1).max(2147483647),
  categoryId: z.uuid(),
  sku: generatedProductSkuSchema,
  slug: productSlugSchema,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(2000).nullable(),
  active: z.boolean(),
  published: z.boolean(),
  sellablePdv: z.boolean(),
  reservable: z.boolean(),
  tracksLots: z.boolean(),
});

export const saveCatalogProductSchema = catalogProductSchema.omit({ id: true, revision: true, sku: true }).extend({
  id: z.uuid().nullable(),
  expectedRevision: z.number().int().min(1).max(2147483647).nullable(),
  reason: z.string().trim().min(4).max(500),
}).strict().refine((value) => (value.id === null) === (value.expectedRevision === null), {
  message: "Informe a revisão ao editar um produto existente",
});

export const saveCatalogProductResponseSchema = z.object({
  data: catalogProductSchema.extend({ correlationId: z.uuid() }),
  request_id: z.string().min(1),
});

export type CatalogProduct = z.infer<typeof catalogProductSchema>;
