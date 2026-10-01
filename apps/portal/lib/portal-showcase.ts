import { portalHighlightSchema } from "@germinatura/contracts";
import { z } from "zod";

// Shape returned by private.portal_highlight_json.
export const databaseHighlightSchema = z.object({
  title: z.string(), message: z.string().nullable(), cta_label: z.string().nullable(), cta_url: z.string().nullable(),
  active: z.boolean(), visible_until: z.string().nullable(), updated_at: z.string(),
});

export function toHighlight(value: z.infer<typeof databaseHighlightSchema>) {
  return portalHighlightSchema.parse({
    title: value.title, message: value.message, ctaLabel: value.cta_label, ctaUrl: value.cta_url, active: value.active,
    visibleUntil: value.visible_until, updatedAt: value.updated_at,
  });
}
