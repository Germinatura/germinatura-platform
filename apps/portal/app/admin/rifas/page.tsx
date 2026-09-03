import { hasPermission } from "@germinatura/auth";
import { redirect } from "next/navigation";
import { z } from "zod";
import { RafflesManager } from "@/components/admin/RafflesManager";
import { requireSession } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const optionsSchema = z.array(z.object({ id: z.uuid(), name: z.string() }));
const campaignsSchema = z.array(z.object({
  id: z.uuid(), name: z.string(), number_count: z.number().int(),
  status: z.enum(["ACTIVE", "CLOSED", "DRAWN", "CANCELLED"]), starts_at: z.string(), ends_at: z.string(),
}));
const drawsSchema = z.array(z.object({
  campaign_id: z.uuid(), winner_number: z.number().int(), winner_index: z.number().int(),
  eligible_numbers: z.array(z.number().int()), random_material: z.string(), audit_hash: z.string(),
}));

export default async function RafflesAdminPage() {
  const user = await requireSession();
  if (!hasPermission(user, "raffles.manage")) redirect("/");
  const client = await createSupabaseServerClient();
  const [flags, campaigns, products, locations] = await Promise.all([
    client.from("feature_flags").select("enabled").eq("key", "raffles").maybeSingle(),
    client.from("raffle_campaigns").select("id,name,number_count,status,starts_at,ends_at").order("created_at", { ascending: false }).limit(50),
    client.from("products").select("id,name").eq("active", true).eq("published", true).order("name").limit(200),
    client.from("stock_locations").select("id,name").eq("active", true).eq("location_type", "CENTRAL").order("name").limit(200),
  ]);
  const parsedCampaigns = campaignsSchema.safeParse(campaigns.data);
  const ids = parsedCampaigns.success ? parsedCampaigns.data.map((item) => item.id) : [];
  const draws = ids.length ? await client.from("raffle_draws").select("campaign_id,winner_number,winner_index,eligible_numbers,random_material,audit_hash").in("campaign_id", ids) : { data: [], error: null };
  const parsedDraws = drawsSchema.safeParse(draws.data);
  const parsedProducts = optionsSchema.safeParse(products.data);
  const parsedLocations = optionsSchema.safeParse(locations.data);
  const unavailable = Boolean(flags.error || campaigns.error || products.error || locations.error || draws.error
    || !parsedCampaigns.success || !parsedDraws.success || !parsedProducts.success || !parsedLocations.success);
  return <RafflesManager campaigns={parsedCampaigns.success ? parsedCampaigns.data : []}
    draws={parsedDraws.success ? parsedDraws.data : []} products={parsedProducts.success ? parsedProducts.data : []}
    locations={parsedLocations.success ? parsedLocations.data : []} enabled={flags.data?.enabled === true} unavailable={unavailable} />;
}
