import { Card } from "@germinatura/ui";
import { FundraisingGoalProgress } from "@/components/goal/FundraisingGoalProgress";
import { loadPublicFundraisingGoal } from "@/lib/fundraising-goal";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** Spec 4.1: the published fundraising goal on the class home page; nothing when it is not published. */
export async function PublicGoalCard() {
  const goal = await loadPublicFundraisingGoal(await createSupabaseServerClient());
  if (!goal) return null;
  return <Card className="p-6"><FundraisingGoalProgress goal={goal} /></Card>;
}
