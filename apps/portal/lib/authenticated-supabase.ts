import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { COHORT_HEADER, cohortHeaders, parseCohortSelection } from "@/lib/cohort-context";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function createAuthenticatedSupabaseClient(request: Request): Promise<SupabaseClient> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return createSupabaseServerClient();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase public environment is not configured");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    // The proxy left only the validated cohort selection in the request (lib/cohort-context.ts).
    global: { headers: { Authorization: authorization, ...cohortHeaders(parseCohortSelection(request.headers.get(COHORT_HEADER))) } },
  });
}
