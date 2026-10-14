import { fundraisingGoalSchema, type FundraisingGoal } from "@germinatura/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const n = z.coerce.number();
const nullable = z.coerce.number().nullable();
const databaseSchema = z.object({
  counting_from: z.string(), target_date: z.string(), public_visible: z.boolean().optional(), show_amounts: z.boolean(),
  target_cents: nullable, current_cents: nullable, projected_cents: nullable, progress_bps: n, projected_bps: n,
  on_track: z.boolean(), days_remaining: n, updated_at: z.string().nullable().optional(),
  basis: z.literal("NET_AVAILABLE").optional(), accumulated_cents: nullable.optional(), committed_cents: nullable.optional(),
  receivables_cents: nullable.optional(), operating_result_since_cents: nullable.optional(),
  accounts: z.object({ free_cents: n, vault_cents: n, cash_cents: n }).nullable().optional(),
}).nullable();

/** Maps the goal progress computed by the database; null when there is no goal (or it is not public). */
export function toFundraisingGoal(data: unknown): FundraisingGoal | null {
  const parsed = databaseSchema.safeParse(data);
  if (!parsed.success) throw new Error("FUNDRAISING_GOAL_INVALID");
  const value = parsed.data;
  if (!value) return null;
  return fundraisingGoalSchema.parse({
    countingFrom: value.counting_from, targetDate: value.target_date, publicVisible: value.public_visible,
    showAmounts: value.show_amounts, targetCents: value.target_cents, currentCents: value.current_cents,
    projectedCents: value.projected_cents, progressBps: value.progress_bps, projectedBps: value.projected_bps,
    onTrack: value.on_track, daysRemaining: value.days_remaining, updatedAt: value.updated_at ?? null,
    basis: value.basis, accumulatedCents: value.accumulated_cents ?? null, committedCents: value.committed_cents ?? null,
    receivablesCents: value.receivables_cents ?? null, operatingResultSinceCents: value.operating_result_since_cents ?? null,
    accounts: value.accounts ? { freeCents: value.accounts.free_cents, vaultCents: value.accounts.vault_cents, cashCents: value.accounts.cash_cents } : null,
  });
}

/** Spec 4.1: the published goal for the home page, or null (not configured, not public or unavailable). */
export async function loadPublicFundraisingGoal(client: SupabaseClient): Promise<FundraisingGoal | null> {
  const { data, error } = await client.rpc("public_fundraising_goal");
  if (error) return null;
  try { return toFundraisingGoal(data); } catch { return null; }
}
