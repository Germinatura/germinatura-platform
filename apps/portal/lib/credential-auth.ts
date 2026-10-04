import { loginIdentifierSchema } from "@germinatura/contracts";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const resolvedIdentifierSchema = z.object({
  user_id: z.uuid(),
  email: z.email(),
  active: z.boolean(),
  onboarding_completed: z.boolean(),
});

export type ResolvedIdentifier = z.infer<typeof resolvedIdentifierSchema>;

export async function resolveLoginIdentifier(identifier: string): Promise<ResolvedIdentifier | null> {
  const normalized = loginIdentifierSchema.parse(identifier);
  const { data, error } = await createSupabaseAdminClient().rpc("resolve_login_identifier", {
    p_identifier: normalized,
  });
  if (error) throw new Error("IDENTIFIER_RESOLUTION_UNAVAILABLE");
  if (data === null) return null;
  const parsed = resolvedIdentifierSchema.safeParse(data);
  if (!parsed.success) throw new Error("IDENTIFIER_RESOLUTION_INVALID");
  return parsed.data;
}
