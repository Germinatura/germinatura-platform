import { z } from "zod";

// Spec 4.2 / 5.13 (GROW-001): shareable campaigns with tracked links.
export const shareChannelSchema = z.enum(["WHATSAPP", "INSTAGRAM", "MURAL", "PRESENCIAL", "OUTRO"]);
export type ShareChannel = z.infer<typeof shareChannelSchema>;
export const shareCodeSchema = z.string().regex(/^[a-z0-9]{8}$/);

export const createShareCampaignRequestSchema = z.object({
  title: z.string().trim().min(3).max(120),
  channel: shareChannelSchema,
  productIds: z.array(z.uuid()).max(20),
}).strict();
export type CreateShareCampaignRequest = z.infer<typeof createShareCampaignRequestSchema>;

export const shareCampaignSchema = z.object({
  id: z.uuid(),
  code: shareCodeSchema,
  title: z.string(),
  channel: shareChannelSchema,
  productIds: z.array(z.uuid()),
  createdAt: z.iso.datetime({ offset: true }),
  createdByName: z.string(),
  visits: z.number().int().nonnegative(),
  reservations: z.number().int().nonnegative(),
  reservedTotalCents: z.number().int().nonnegative(),
  sellerName: z.string().nullable(),
  paidSales: z.number().int().nonnegative(),
  paidTotalCents: z.number().int(),
}).strict();
export type ShareCampaign = z.infer<typeof shareCampaignSchema>;

export const shareCampaignsResponseSchema = z.object({
  data: z.array(shareCampaignSchema),
  request_id: z.string().min(1),
}).strict();

export const createShareCampaignResponseSchema = z.object({
  data: z.object({ id: z.uuid(), code: shareCodeSchema, title: z.string(), channel: shareChannelSchema, productIds: z.array(z.uuid()) }).strict(),
  request_id: z.string().min(1),
}).strict();

// GROW-002: links of the seller, and the origin of a PDV sale.
export const createSellerShareLinkRequestSchema = createShareCampaignRequestSchema;
export const sellerShareLinksResponseSchema = z.object({
  data: z.object({
    links: z.array(shareCampaignSchema),
    campaigns: z.array(z.object({ code: shareCodeSchema, title: z.string(), channel: shareChannelSchema, mine: z.boolean() }).strict()),
  }).strict(),
  request_id: z.string().min(1),
}).strict();
export type SellerShareLinksResponse = z.infer<typeof sellerShareLinksResponseSchema>;
export const sellerShareLinkResponseSchema = z.object({ data: shareCampaignSchema, request_id: z.string().min(1) }).strict();
export const attributePdvSaleRequestSchema = z.object({ code: shareCodeSchema }).strict();
export const attributePdvSaleResponseSchema = z.object({
  data: z.object({ saleId: z.uuid(), campaignCode: shareCodeSchema, campaignTitle: z.string() }).strict(),
  request_id: z.string().min(1),
}).strict();
