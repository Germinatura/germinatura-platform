import { z } from "zod";
import { createPublicSupabaseClient } from "@/lib/supabase/public";

const resolvedSchema = z.object({ id: z.uuid(), name: z.string(), year: z.number().int(), slug: z.string(), is_default: z.boolean() });
export type PublicCohort = z.infer<typeof resolvedSchema>;

/**
 * ADR 0011 (PR 5): visitors name a cohort by its public slug (`?turma=`). The database resolves it to an ACTIVE cohort;
 * anything else (unknown, malformed, PREPARING or ARCHIVED) resolves to nothing, and the caller answers 404 instead of
 * falling back to the default cohort.
 */
export async function resolvePublicCohort(slug: string): Promise<PublicCohort | null> {
  if (!/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(slug)) return null;
  const { data, error } = await createPublicSupabaseClient().rpc("resolve_public_cohort", { p_slug: slug });
  if (error || data === null) return null;
  const parsed = resolvedSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
