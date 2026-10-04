import { hasPermission } from "@germinatura/auth";
import { redirect } from "next/navigation";
import { z } from "zod";
import { CloseoutsManager, type CloseoutListItem } from "@/components/admin/CloseoutsManager";
import { requireSession } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const closeoutsSchema = z.array(z.object({
  id: z.uuid(), seller_id: z.uuid(), seller_name: z.string().nullable(), seller_email: z.email(), location_id: z.uuid(), location_name: z.string(),
  period_start: z.string(), period_end: z.string(), status: z.enum(["CLOSED", "REOPENED"]),
  confirmed_sales_count: z.number().int().nonnegative(), confirmed_sales_total_cents: z.number().int().nonnegative(),
  payment_count: z.number().int().nonnegative(), payment_total_cents: z.number().int().nonnegative(),
  payment_difference_cents: z.number().int(), stock_difference_units: z.number().int().nonnegative(),
  justification: z.string().nullable(), created_at: z.string(), reopened_at: z.string().nullable(), reopen_reason: z.string().nullable(),
}));
export default async function AdminCloseoutsPage() {
  const user = await requireSession();
  if (!hasPermission(user, "closeouts.manage")) redirect("/");
  const client = await createSupabaseServerClient();
  const closeoutsResult = await client.rpc("list_managed_seller_closeouts", { p_limit: 100 });
  const parsedCloseouts = closeoutsSchema.safeParse(closeoutsResult.data);
  const closeouts = parsedCloseouts.success ? parsedCloseouts.data : [];
  const unavailable = Boolean(closeoutsResult.error || !parsedCloseouts.success);
  const items: CloseoutListItem[] = closeouts.map((closeout) => ({
    id: closeout.id,
    sellerName: closeout.seller_name ?? closeout.seller_email,
    locationName: closeout.location_name,
    periodStart: closeout.period_start, periodEnd: closeout.period_end, status: closeout.status,
    confirmedSalesCount: closeout.confirmed_sales_count, confirmedSalesTotalCents: closeout.confirmed_sales_total_cents,
    paymentCount: closeout.payment_count, paymentTotalCents: closeout.payment_total_cents,
    paymentDifferenceCents: closeout.payment_difference_cents, stockDifferenceUnits: closeout.stock_difference_units,
    justification: closeout.justification, createdAt: closeout.created_at,
    reopenedAt: closeout.reopened_at, reopenReason: closeout.reopen_reason,
  }));
  return <CloseoutsManager initialItems={items} unavailable={unavailable} />;
}
