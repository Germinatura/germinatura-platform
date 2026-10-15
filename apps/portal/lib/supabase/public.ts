import { createClient } from "@supabase/supabase-js";
import { COHORT_HEADER } from "@germinatura/contracts";

/**
 * Anonymous client. Without a cohort it reads the public default cohort; with one, the cohort must come from
 * `resolvePublicCohort` (an ACTIVE cohort resolved server-side from a public slug or a share link), never from input.
 */
export function createPublicSupabaseClient(cohortId?: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) throw new Error("Supabase public environment is not configured");

  return createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    ...(cohortId ? { global: { headers: { [COHORT_HEADER]: cohortId } } } : {}),
  });
}
