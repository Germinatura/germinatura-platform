import { z } from "zod";

// Spec 4.5 (EVT-001): public area of events and sales campaigns.
export const portalEventKindSchema = z.enum(["EVENTO", "CAMPANHA"]);
export type PortalEventKind = z.infer<typeof portalEventKindSchema>;
export const portalEventStatusSchema = z.enum(["RASCUNHO", "PUBLICADO", "CANCELADO"]);
export type PortalEventStatus = z.infer<typeof portalEventStatusSchema>;

const timestamp = z.iso.datetime({ offset: true });
const httpsUrl = z.string().trim().max(500).regex(/^https:\/\/\S{3,}$/, "Use um link https");
const ctaUrl = z.string().trim().max(500).regex(/^(https:\/\/\S{3,}|\/[A-Za-z0-9/_?=&.-]*)$/, "Use um link https ou um caminho do Portal");

export const portalEventSchema = z.object({
  id: z.uuid(),
  kind: portalEventKindSchema,
  title: z.string(),
  description: z.string(),
  startsAt: timestamp,
  endsAt: timestamp.nullable(),
  location: z.string().nullable(),
  externalUrl: z.string().nullable(),
  ctaLabel: z.string().nullable(),
  ctaUrl: z.string().nullable(),
  coverUrl: z.string().nullable(),
  coverAlt: z.string().nullable(),
  status: portalEventStatusSchema,
  over: z.boolean(),
  publishedAt: timestamp.nullable(),
  cancelledAt: timestamp.nullable(),
  cancelReason: z.string().nullable(),
  products: z.array(z.object({ id: z.uuid(), name: z.string() }).strict()),
  promotions: z.array(z.object({ id: z.uuid(), name: z.string(), validFrom: timestamp, validTo: timestamp.nullable() }).strict()),
  sellers: z.array(z.object({ id: z.uuid(), name: z.string() }).strict()),
  revision: z.number().int().nullable(),
  updatedAt: timestamp.nullable(),
}).strict();
export type PortalEvent = z.infer<typeof portalEventSchema>;

export const portalEventResponseSchema = z.object({ data: portalEventSchema, request_id: z.string().min(1) }).strict();
export const portalEventsResponseSchema = z.object({ data: z.array(portalEventSchema), request_id: z.string().min(1) }).strict();
export const portalEventsAdminResponseSchema = z.object({
  data: z.array(portalEventSchema),
  sellers: z.array(z.object({ id: z.uuid(), name: z.string() }).strict()),
  promotions: z.array(z.object({ id: z.uuid(), name: z.string() }).strict()),
  request_id: z.string().min(1),
}).strict();
export type PortalEventsAdminResponse = z.infer<typeof portalEventsAdminResponseSchema>;

export const portalEventsQuerySchema = z.object({ archive: z.enum(["true", "false"]).optional() }).strict();

export const savePortalEventRequestSchema = z.object({
  expectedRevision: z.number().int().positive().nullable(),
  kind: portalEventKindSchema,
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(3).max(4000),
  startsAt: timestamp,
  endsAt: timestamp.nullable(),
  location: z.string().trim().min(2).max(160).nullable(),
  externalUrl: httpsUrl.nullable(),
  ctaLabel: z.string().trim().min(2).max(40).nullable(),
  ctaUrl: ctaUrl.nullable(),
  productIds: z.array(z.uuid()).max(20),
  promotionIds: z.array(z.uuid()).max(10),
  sellerIds: z.array(z.uuid()).max(50),
}).strict().superRefine((value, context) => {
  if (value.endsAt && value.endsAt < value.startsAt) context.addIssue({ code: "custom", path: ["endsAt"], message: "O fim precisa ser depois do início" });
  if ((value.ctaLabel === null) !== (value.ctaUrl === null)) context.addIssue({ code: "custom", path: ["ctaUrl"], message: "Informe o texto e o link da chamada" });
});
export type SavePortalEventRequest = z.infer<typeof savePortalEventRequestSchema>;

export const transitionPortalEventRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("PUBLICAR") }).strict(),
  z.object({ action: z.literal("CANCELAR"), reason: z.string().trim().min(8).max(300) }).strict(),
]);
export type TransitionPortalEventRequest = z.infer<typeof transitionPortalEventRequestSchema>;

export const portalEventCoverQuerySchema = z.object({ alt: z.string().trim().min(1).max(180) }).strict();
