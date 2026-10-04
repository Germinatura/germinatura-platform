import { raffleCampaignCancelRequestSchema } from "@germinatura/contracts";
import { runRaffleAdminAction } from "@/lib/raffle-admin";

/** Spec 5.11: cancels a raffle before its draw; paid sales are then refunded by finance. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return runRaffleAdminAction(request, context, raffleCampaignCancelRequestSchema, (campaignId, body) => ({
    name: "cancel_raffle_campaign", args: { p_campaign_id: campaignId, p_reason: body.reason },
  }));
}
