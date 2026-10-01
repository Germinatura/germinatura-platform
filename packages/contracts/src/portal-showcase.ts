import { z } from "zod";
import { portalEventSchema } from "./portal-events";

// Spec 4.1 (VIT-001): what the Início page shows.
const timestamp = z.iso.datetime({ offset: true });
const ctaUrl = z.string().trim().max(500).regex(/^(https:\/\/\S{3,}|\/[A-Za-z0-9/_?=&.-]*)$/, "Use um link https ou um caminho do Portal");

export const portalHighlightSchema = z.object({
  title: z.string(),
  message: z.string().nullable(),
  ctaLabel: z.string().nullable(),
  ctaUrl: z.string().nullable(),
  active: z.boolean(),
  visibleUntil: timestamp.nullable(),
  updatedAt: timestamp,
}).strict();
export type PortalHighlight = z.infer<typeof portalHighlightSchema>;

export const portalShowcaseSchema = z.object({
  highlight: portalHighlightSchema.nullable(),
  newProducts: z.array(z.object({
    id: z.uuid(), name: z.string(), category: z.string(), imageUrl: z.string().nullable(), imageAlt: z.string().nullable(),
  }).strict()),
  promotions: z.array(z.object({ id: z.uuid(), name: z.string(), description: z.string().nullable(), validTo: timestamp.nullable() }).strict()),
  events: z.array(portalEventSchema),
  raffles: z.array(z.object({
    id: z.uuid(), name: z.string(), endsAt: timestamp, numberCount: z.number().int().positive(), availableCount: z.number().int().nonnegative(),
  }).strict()),
}).strict();
export type PortalShowcase = z.infer<typeof portalShowcaseSchema>;

export const portalShowcaseResponseSchema = z.object({ data: portalShowcaseSchema, request_id: z.string().min(1) }).strict();
export const portalHighlightResponseSchema = z.object({ data: portalHighlightSchema.nullable(), request_id: z.string().min(1) }).strict();

export const savePortalHighlightRequestSchema = z.object({
  title: z.string().trim().min(3).max(80),
  message: z.string().trim().min(3).max(280).nullable(),
  ctaLabel: z.string().trim().min(2).max(40).nullable(),
  ctaUrl: ctaUrl.nullable(),
  active: z.boolean(),
  visibleUntil: timestamp.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.ctaLabel === null) !== (value.ctaUrl === null)) context.addIssue({ code: "custom", path: ["ctaUrl"], message: "Informe o texto e o link da chamada" });
});
export type SavePortalHighlightRequest = z.infer<typeof savePortalHighlightRequestSchema>;
