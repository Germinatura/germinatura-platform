import { z } from "zod";

export const catalogProductImageSchema = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  objectPath: z.string().min(1).max(500),
  altText: z.string().trim().min(1).max(180),
  sortOrder: z.number().int().min(0).max(5),
  publicUrl: z.url(),
});

export const publicCatalogProductImageSchema = catalogProductImageSchema.pick({
  id: true, altText: true, sortOrder: true, publicUrl: true,
});

export const uploadCatalogProductImageSchema = z.object({
  imageId: z.uuid(),
  productId: z.uuid(),
  expectedRevision: z.number().int().min(1).max(2147483647),
  altText: z.string().trim().min(1).max(180),
  reason: z.string().trim().min(4).max(500),
}).strict();

export const reorderCatalogProductImagesSchema = z.object({
  productId: z.uuid(),
  expectedRevision: z.number().int().min(1).max(2147483647),
  imageIds: z.array(z.uuid()).min(1).max(6),
  reason: z.string().trim().min(4).max(500),
}).strict().refine((value) => new Set(value.imageIds).size === value.imageIds.length, {
  message: "A ordem não pode repetir imagens",
  path: ["imageIds"],
});

export const removeCatalogProductImageSchema = z.object({
  productId: z.uuid(),
  expectedRevision: z.number().int().min(1).max(2147483647),
  reason: z.string().trim().min(4).max(500),
}).strict();

export const catalogProductImageMutationResponseSchema = z.object({
  data: catalogProductImageSchema.extend({
    productRevision: z.number().int().min(1).max(2147483647),
    correlationId: z.uuid(),
  }),
  request_id: z.string().min(1),
});

export const reorderCatalogProductImagesResponseSchema = z.object({
  data: z.object({
    productId: z.uuid(),
    productRevision: z.number().int().min(1).max(2147483647),
    imageIds: z.array(z.uuid()).min(1).max(6),
    correlationId: z.uuid(),
  }),
  request_id: z.string().min(1),
});

export const removeCatalogProductImageResponseSchema = z.object({
  data: z.object({
    id: z.uuid(),
    productId: z.uuid(),
    objectPath: z.string().min(1).max(500),
    productRevision: z.number().int().min(1).max(2147483647),
    correlationId: z.uuid(),
  }),
  request_id: z.string().min(1),
});

export type CatalogProductImage = z.infer<typeof catalogProductImageSchema>;
