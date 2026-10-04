import { raffleCampaignUpdateRequestSchema } from "@germinatura/contracts";
import { runRaffleAdminAction } from "@/lib/raffle-admin";

/** Spec 5.11: edits a raffle while it is still a draft. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return runRaffleAdminAction(request, context, raffleCampaignUpdateRequestSchema, (campaignId, body) => ({
    name: "update_raffle_campaign",
    args: {
      p_campaign_id: campaignId, p_name: body.name, p_description: body.description, p_product_id: body.productId,
      p_location_id: body.locationId, p_number_count: body.numberCount, p_starts_at: body.startsAt, p_ends_at: body.endsAt,
    },
  }));
}
