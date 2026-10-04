import { shareCampaignSchema } from "@germinatura/contracts";
import { z } from "zod";

// Rows returned by private.share_campaign_json.
export const databaseShareCampaignSchema = z.object({
  id: z.uuid(), code: z.string(), title: z.string(), channel: z.string(), product_ids: z.array(z.uuid()), created_at: z.string(),
  created_by_name: z.string(), seller_name: z.string().nullable(), visits: z.number().int(), reservations: z.number().int(),
  reserved_total_cents: z.number().int(), paid_sales: z.number().int(), paid_total_cents: z.number().int(),
});

export function toShareCampaign(row: z.infer<typeof databaseShareCampaignSchema>) {
  return shareCampaignSchema.parse({
    id: row.id, code: row.code, title: row.title, channel: row.channel, productIds: row.product_ids, createdAt: row.created_at,
    createdByName: row.created_by_name, visits: row.visits, reservations: row.reservations, reservedTotalCents: row.reserved_total_cents,
    sellerName: row.seller_name, paidSales: row.paid_sales, paidTotalCents: row.paid_total_cents,
  });
}
