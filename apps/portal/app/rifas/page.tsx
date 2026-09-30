import { hasPermission } from "@germinatura/auth";
import { redirect } from "next/navigation";
import { z } from "zod";
import { ConsumerRaffles, type ConsumerRaffle, type RaffleTicket } from "@/components/raffles/ConsumerRaffles";
import { requireSession } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Spec 15.5: the buyer listing only carries the buyer's own numbers, never who holds the others.
const rowsSchema = z.array(z.object({
  campaign_id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  product_name: z.string(),
  number_count: z.number().int().positive(),
  unit_price_cents: z.number().int().nullable(),
  available_count: z.number().int(),
  status: z.enum(["ACTIVE", "PAUSED", "CLOSED", "DRAWN", "CANCELLED"]),
  starts_at: z.string(),
  ends_at: z.string(),
  draw: z.object({ winner_number: z.number().int().positive(), audit_hash: z.string(), drawn_at: z.string() }).nullable(),
}).passthrough());
const ticketsSchema = z.array(z.object({
  sale_id: z.uuid(), campaign_id: z.uuid(), campaign_name: z.string(), numbers: z.array(z.number().int()),
  sale_status: z.enum(["DRAFT", "AWAITING_PAYMENT", "CONFIRMED", "CANCELLED"]), total_cents: z.number().int(),
  expires_at: z.string().nullable(), open_payment_link_id: z.uuid().nullable(),
  payment: z.object({ status: z.string().optional(), confirmation_source: z.string().nullable() }).passthrough().nullable(), won: z.boolean(),
}).passthrough());

export default async function RafflesPage() {
  const user = await requireSession();
  if (!hasPermission(user, "raffles.buy")) redirect("/");

  const client = await createSupabaseServerClient();
  const [flags, rafflesResult, ticketsResult] = await Promise.all([
    client.from("feature_flags").select("key,enabled").in("key", ["raffles", "payment_link"]),
    client.rpc("list_raffles_for_buyer"),
    client.rpc("list_my_raffle_tickets"),
  ]);
  const rows = rowsSchema.safeParse(rafflesResult.data);
  const ticketRows = ticketsSchema.safeParse(ticketsResult.data);
  const unavailable = Boolean(flags.error || rafflesResult.error || ticketsResult.error || !rows.success || !ticketRows.success);
  const enabledKeys = new Set((flags.data ?? []).filter((flag) => flag.enabled).map((flag) => flag.key));
  const raffles: ConsumerRaffle[] = rows.success ? rows.data.map((row) => ({
    id: row.campaign_id, name: row.name, description: row.description, productName: row.product_name, numberCount: row.number_count,
    unitPriceCents: row.unit_price_cents, availableCount: row.available_count, status: row.status, startsAt: row.starts_at, endsAt: row.ends_at,
    draw: row.draw ? { winnerNumber: row.draw.winner_number, auditHash: row.draw.audit_hash, createdAt: row.draw.drawn_at } : null,
  })) : [];
  const tickets: RaffleTicket[] = ticketRows.success ? ticketRows.data.map((row) => ({
    saleId: row.sale_id, campaignId: row.campaign_id, campaignName: row.campaign_name, numbers: row.numbers, saleStatus: row.sale_status,
    totalCents: row.total_cents, expiresAt: row.expires_at, openPaymentLinkId: row.open_payment_link_id,
    confirmationSource: row.payment?.confirmation_source ?? null, won: row.won,
    refunded: row.payment?.status === "REFUNDED",
  })) : [];

  return <ConsumerRaffles raffles={raffles} tickets={tickets} enabled={enabledKeys.has("raffles")}
    onlinePayment={enabledKeys.has("payment_link")} unavailable={unavailable} />;
}
