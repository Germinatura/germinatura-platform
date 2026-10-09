import { createServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";
import { COHORT_HEADER, cohortHeaders, parseCohortSelection } from "@/lib/cohort-context";

function publicConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) throw new Error("Supabase public environment is not configured");
  return { url, publishableKey };
}

// Pages and routes run after the proxy, which leaves in the request only the cohort selection it validated
// (lib/cohort-context.ts); every database call of the request carries it.
export async function createSupabaseServerClient(cohortOverride?: string) {
  const { url, publishableKey } = publicConfig();
  const cookieStore = await cookies();
  // ADR 0011 (PR 4): the consolidated view of ADMIN_MASTER reads each cohort inside that cohort; the database validates
  // the override exactly like any other selection.
  const cohort = cohortOverride ? parseCohortSelection(cohortOverride) : parseCohortSelection((await headers()).get(COHORT_HEADER));
  if (cohortOverride && !cohort) throw new Error("INVALID_COHORT_CONTEXT");
  return createServerClient(url, publishableKey, {
    global: { headers: cohortHeaders(cohort) },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components cannot always write refreshed cookies. Middleware
          // performs the refresh for browser requests.
        }
      },
    },
  });
}
