import { hasPermission } from "@germinatura/auth";
import { redirect } from "next/navigation";
import { z } from "zod";
import { ConsumerRaffles, type ConsumerRaffle } from "@/components/raffles/ConsumerRaffles";
import { requireSession } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const campaignRowsSchema = z.array(z.object({
  id: z.uuid(),
  name: z.string(),
  number_count: z.number().int().positive(),
  status: z.enum(["ACTIVE", "CLOSED", "DRAWN", "CANCELLED"]),
  starts_at: z.string(),
  ends_at: z.string(),
  products: z.object({ name: z.string(), sku: z.string() }).nullable(),
}));

const ownedNumberRowsSchema = z.array(z.object({
  campaign_id: z.uuid(),
  number: z.number().int().positive(),
  status: z.enum(["RESERVED", "PAID"]),
  sale_id: z.uuid(),
  expires_at: z.string(),
}));

const drawRowsSchema = z.array(z.object({
  campaign_id: z.uuid(),
  winner_number: z.number().int().positive(),
  audit_hash: z.string(),
  created_at: z.string(),
}));

export default async function RafflesPage() {
  const user = await requireSession();
  if (!hasPermission(user, "raffles.buy")) redirect("/");

  const client = await createSupabaseServerClient();
  const [flagResult, campaignsResult, ownedNumbersResult, drawsResult] = await Promise.all([
    client.from("feature_flags").select("enabled").eq("key", "raffles").maybeSingle(),
    client.from("raffle_campaigns")
      .select("id,name,number_count,status,starts_at,ends_at,products(name,sku)")
      .order("created_at", { ascending: false })
      .limit(30),
    client.from("raffle_numbers")
      .select("campaign_id,number,status,sale_id,expires_at")
      .eq("reserved_by", user.id)
      .in("status", ["RESERVED", "PAID"])
      .order("number", { ascending: true })
      .limit(500),
    client.from("raffle_draws")
      .select("campaign_id,winner_number,audit_hash,created_at")
      .order("created_at", { ascending: false })
      .limit(30),
  ]);

  const campaigns = campaignRowsSchema.safeParse(campaignsResult.data);
  const ownedNumbers = ownedNumberRowsSchema.safeParse(ownedNumbersResult.data);
  const draws = drawRowsSchema.safeParse(drawsResult.data);
  const unavailable = Boolean(
    flagResult.error || campaignsResult.error || ownedNumbersResult.error || drawsResult.error
      || !campaigns.success || !ownedNumbers.success || !draws.success,
  );
  const enabled = flagResult.data?.enabled === true;

  const numbersByCampaign = new Map<string, ConsumerRaffle["ownedNumbers"]>();
  if (ownedNumbers.success) {
    for (const item of ownedNumbers.data) {
      const current = numbersByCampaign.get(item.campaign_id) ?? [];
      current.push({ number: item.number, status: item.status, saleId: item.sale_id, expiresAt: item.expires_at });
      numbersByCampaign.set(item.campaign_id, current);
    }
  }
  const drawsByCampaign = new Map(draws.success ? draws.data.map((draw) => [draw.campaign_id, draw] as const) : []);
  const raffles: ConsumerRaffle[] = campaigns.success ? campaigns.data.map((campaign) => ({
    id: campaign.id,
    name: campaign.name,
    productName: campaign.products?.name ?? "Produto da campanha",
    productSku: campaign.products?.sku ?? null,
    numberCount: campaign.number_count,
    status: campaign.status,
    startsAt: campaign.starts_at,
    endsAt: campaign.ends_at,
    ownedNumbers: numbersByCampaign.get(campaign.id) ?? [],
    draw: drawsByCampaign.has(campaign.id) ? {
      winnerNumber: drawsByCampaign.get(campaign.id)!.winner_number,
      auditHash: drawsByCampaign.get(campaign.id)!.audit_hash,
      createdAt: drawsByCampaign.get(campaign.id)!.created_at,
    } : null,
  })) : [];

  return <ConsumerRaffles raffles={raffles} enabled={enabled} unavailable={unavailable} />;
}
