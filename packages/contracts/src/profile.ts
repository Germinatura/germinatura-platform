import { z } from "zod";

export const sweetPreferences = ["Chocolate", "Caramelo", "Frutas", "Coco", "Baunilha", "Castanhas", "Brownie", "Cookie", "Brigadeiro", "Bolo", "Bala", "Chocolate branco"] as const;
export const updateProfileSchema = z.object({
  expectedRevision: z.number().int().min(0).max(2147483646),
  displayName: z.string().trim().min(2).max(120),
  avatarPath: z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$/).nullable(),
  bio: z.string().trim().max(280),
  className: z.string().trim().max(60),
  sweetPreferences: z.array(z.enum(sweetPreferences)).max(8).refine((items) => new Set(items).size === items.length),
}).strict();
export const privateProfileSchema = updateProfileSchema.omit({ expectedRevision: true }).extend({
  revision: z.number().int().min(0),
  id: z.string().uuid(), email: z.string().email(), username: z.string(), avatarUrl: z.string().nullable(),
});
export type PrivateProfile = z.infer<typeof privateProfileSchema>;

// Spec 4.8: the person's own signed-in sessions (no IP), current first.
export const accountSessionSchema = z.object({
  id: z.uuid(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  userAgent: z.string().nullable(),
  current: z.boolean(),
}).strict();
export type AccountSession = z.infer<typeof accountSessionSchema>;
export const accountSessionsResponseSchema = z.object({ data: z.array(accountSessionSchema), request_id: z.string().min(1) }).strict();
export const endAccountSessionsResponseSchema = z.object({ data: z.object({ ended: z.number().int().nonnegative() }).strict(), request_id: z.string().min(1) }).strict();
