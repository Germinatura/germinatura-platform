import { z } from "zod";

export const catalogCategorySchema = z.object({
  id: z.uuid(),
  revision: z.number().int().min(1).max(2147483647),
  name: z.string().trim().min(1).max(120),
  slug: z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  active: z.boolean(),
  sortOrder: z.number().int().min(0).max(2147483647),
});

export const saveCatalogCategorySchema = catalogCategorySchema.omit({ id: true, revision: true }).extend({
  id: z.uuid().nullable(),
  expectedRevision: z.number().int().min(1).max(2147483647).nullable(),
  reason: z.string().trim().min(4).max(500),
}).strict().refine((value) => (value.id === null) === (value.expectedRevision === null), {
  message: "Informe a revisão ao editar uma categoria existente",
});

export const saveCatalogCategoryResponseSchema = z.object({
  data: catalogCategorySchema.extend({ correlationId: z.uuid() }),
  request_id: z.string().min(1),
});

export type CatalogCategory = z.infer<typeof catalogCategorySchema>;
