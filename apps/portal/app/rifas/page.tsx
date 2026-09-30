import { hasPermission } from "@germinatura/auth";
import { redirect } from "next/navigation";
import { z } from "zod";
import { ConsumerRaffles, type ConsumerRaffle } from "@/components/raffles/ConsumerRaffles";
import { requireSession } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Spec 15.5: the buyer listing only carries the buyer's own numbers, never who holds the others.
const rowsSchema = z.array(z.object({
  campaign_id: z.uuid(),
  name: z.string(),
  product_name: z.string(),
  number_count: z.number().int().positive(),
  status: z.enum(["ACTIVE", "PAUSED", "CLOSED", "DRAWN", "CANCELLED"]),
  starts_at: z.string(),
  ends_at: z.string(),
  my_numbers: z.array(z.object({
    number: z.number().int().positive(), status: z.enum(["RESERVED", "PAID"]), sale_id: z.uuid(), expires_at: z.string(),
  })),
  draw: z.object({ winner_number: z.number().int().positive(), audit_hash: z.string(), drawn_at: z.string() }).nullable(),
}).passthrough());

export default async function RafflesPage() {
  const user = await requireSession();
  if (!hasPermission(user, "raffles.buy")) redirect("/");

  const client = await createSupabaseServerClient();
  const [flagResult, rafflesResult] = await Promise.all([
    client.from("feature_flags").select("enabled").eq("key", "raffles").maybeSingle(),
    client.rpc("list_raffles_for_buyer"),
  ]);
  const rows = rowsSchema.safeParse(rafflesResult.data);
  const unavailable = Boolean(flagResult.error || rafflesResult.error || !rows.success);
  const raffles: ConsumerRaffle[] = rows.success ? rows.data.map((row) => ({
    id: row.campaign_id,
    name: row.name,
    productName: row.product_name,
    productSku: null,
    numberCount: row.number_count,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    ownedNumbers: row.my_numbers.map((item) => ({ number: item.number, status: item.status, saleId: item.sale_id, expiresAt: item.expires_at })),
    draw: row.draw ? { winnerNumber: row.draw.winner_number, auditHash: row.draw.audit_hash, createdAt: row.draw.drawn_at } : null,
  })) : [];

  return <ConsumerRaffles raffles={raffles} enabled={flagResult.data?.enabled === true} unavailable={unavailable} />;
}
