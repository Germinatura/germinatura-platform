import { raffleCampaignTransitionRequestSchema } from "@germinatura/contracts";
import { runRaffleAdminAction } from "@/lib/raffle-admin";

/** Spec 5.11: publishes, pauses, resumes or closes a raffle. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return runRaffleAdminAction(request, context, raffleCampaignTransitionRequestSchema, (campaignId, body) => ({
    name: "transition_raffle_campaign", args: { p_campaign_id: campaignId, p_action: body.action },
  }));
}
