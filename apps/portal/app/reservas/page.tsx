import { hasPermission } from "@germinatura/auth";
import { redirect } from "next/navigation";
import { z } from "zod";
import { ConsumerReservations, type ConsumerReservation } from "@/components/reservations/ConsumerReservations";
import { requireSession } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const reservationRowsSchema = z.array(z.object({
  id: z.uuid(),
  status: z.enum(["ACTIVE", "CONVERTED", "CANCELLED", "EXPIRED"]),
  quote_snapshot: z.object({
    lines: z.array(z.object({
      product_id: z.uuid(),
      product_name: z.string(),
      quantity: z.number().int().positive(),
      total_cents: z.number().int().nonnegative(),
    }).passthrough()).min(1),
  }).passthrough(),
  original_total_cents: z.number().int().nonnegative(),
  discount_total_cents: z.number().int().nonnegative(),
  total_cents: z.number().int().nonnegative(),
  expires_at: z.string(),
  created_at: z.string(),
}));

export default async function ReservationsPage() {
  const user = await requireSession();
  if (!hasPermission(user, "reservations.manage.own")) redirect("/");

  const client = await createSupabaseServerClient();
  const result = await client.from("commercial_reservations")
    .select("id,status,quote_snapshot,original_total_cents,discount_total_cents,total_cents,expires_at,created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  const parsed = reservationRowsSchema.safeParse(result.data);
  const unavailable = Boolean(result.error || !parsed.success);
  const reservations: ConsumerReservation[] = parsed.success ? parsed.data.map((reservation) => ({
    id: reservation.id,
    status: reservation.status,
    lines: reservation.quote_snapshot.lines.map((line) => ({
      productId: line.product_id,
      name: line.product_name,
      quantity: line.quantity,
      totalCents: line.total_cents,
    })),
    originalTotalCents: reservation.original_total_cents,
    discountTotalCents: reservation.discount_total_cents,
    totalCents: reservation.total_cents,
    expiresAt: reservation.expires_at,
    createdAt: reservation.created_at,
  })) : [];

  return <ConsumerReservations initialReservations={reservations} unavailable={unavailable} />;
}
