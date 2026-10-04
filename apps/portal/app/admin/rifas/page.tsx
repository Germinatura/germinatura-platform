import { hasPermission } from "@germinatura/auth";
import { adminRaffleCampaignSchema } from "@germinatura/contracts";
import { redirect } from "next/navigation";
import { z } from "zod";
import { RafflesManager } from "@/components/admin/RafflesManager";
import { requireSession } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const optionsSchema = z.array(z.object({ id: z.uuid(), name: z.string() }));
const rowsSchema = z.array(z.object({
  campaign_id: z.uuid(), name: z.string(), description: z.string().nullable(), product_id: z.uuid(), product_name: z.string(),
  location_id: z.uuid(), status: z.string(), number_count: z.number().int(), starts_at: z.string(), ends_at: z.string(),
  published_at: z.string().nullable(), closed_at: z.string().nullable(), cancelled_at: z.string().nullable(),
  cancel_reason: z.string().nullable(), available_count: z.number().int(), reserved_count: z.number().int(),
  paid_count: z.number().int(), paid_total_cents: z.number().int(), paid_sales: z.number().int(),
  draw: z.object({
    winner_number: z.number().int(), winner_index: z.number().int(), eligible_numbers: z.array(z.number().int()),
    random_material: z.string(), audit_hash: z.string(), drawn_at: z.string(),
  }).nullable(),
}));

export default async function RafflesAdminPage() {
  const user = await requireSession();
  if (!hasPermission(user, "raffles.manage")) redirect("/");
  const client = await createSupabaseServerClient();
  const [flags, campaigns, products, locations] = await Promise.all([
    client.from("feature_flags").select("enabled").eq("key", "raffles").maybeSingle(),
    client.rpc("list_raffles_admin", { p_limit: 50 }),
    client.from("products").select("id,name").eq("active", true).eq("published", true).order("name").limit(200),
    client.from("stock_locations").select("id,name").eq("active", true).eq("location_type", "CENTRAL").order("name").limit(200),
  ]);
  const rows = rowsSchema.safeParse(campaigns.data);
  const parsed = rows.success ? z.array(adminRaffleCampaignSchema).safeParse(rows.data.map((row) => ({
    campaignId: row.campaign_id, name: row.name, description: row.description, productId: row.product_id, productName: row.product_name,
    locationId: row.location_id, status: row.status, numberCount: row.number_count, startsAt: row.starts_at, endsAt: row.ends_at,
    publishedAt: row.published_at, closedAt: row.closed_at, cancelledAt: row.cancelled_at, cancelReason: row.cancel_reason,
    availableCount: row.available_count, reservedCount: row.reserved_count, paidCount: row.paid_count,
    paidTotalCents: row.paid_total_cents, paidSales: row.paid_sales,
    draw: row.draw && { winnerNumber: row.draw.winner_number, winnerIndex: row.draw.winner_index, eligibleNumbers: row.draw.eligible_numbers,
      randomMaterial: row.draw.random_material, auditHash: row.draw.audit_hash, drawnAt: row.draw.drawn_at },
  }))) : null;
  const parsedProducts = optionsSchema.safeParse(products.data);
  const parsedLocations = optionsSchema.safeParse(locations.data);
  const unavailable = Boolean(flags.error || campaigns.error || products.error || locations.error
    || !parsed?.success || !parsedProducts.success || !parsedLocations.success);
  return <RafflesManager campaigns={parsed?.success ? parsed.data : []} products={parsedProducts.success ? parsedProducts.data : []}
    locations={parsedLocations.success ? parsedLocations.data : []} enabled={flags.data?.enabled === true} unavailable={unavailable} />;
}
