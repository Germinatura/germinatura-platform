import { fundraisingGoalSchema, type FundraisingGoal } from "@germinatura/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const n = z.coerce.number();
const nullable = z.coerce.number().nullable();
const databaseSchema = z.object({
  counting_from: z.string(), target_date: z.string(), public_visible: z.boolean().optional(), show_amounts: z.boolean(),
  target_cents: nullable, current_cents: nullable, projected_cents: nullable, progress_bps: n, projected_bps: n,
  on_track: z.boolean(), days_remaining: n, updated_at: z.string().nullable().optional(),
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
  });
}

/** Spec 4.1: the published goal for the home page, or null (not configured, not public or unavailable). */
export async function loadPublicFundraisingGoal(client: SupabaseClient): Promise<FundraisingGoal | null> {
  const { data, error } = await client.rpc("public_fundraising_goal");
  if (error) return null;
  try { return toFundraisingGoal(data); } catch { return null; }
}
