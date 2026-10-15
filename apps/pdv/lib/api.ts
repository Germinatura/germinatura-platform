import { createApiClient } from "@germinatura/contracts";
import { browserPdvCohort } from "@/lib/pdv-cohort";
import { getSupabaseBrowserClient } from "@/lib/supabase";

export const apiFetch = createApiClient({
  getAccessToken: async () => {
    const { data } = await getSupabaseBrowserClient().auth.getSession();
    return data.session?.access_token ?? null;
  },
  // ADR 0011: every Portal call carries the PDV cohort; the Portal revalidates it.
  getCohort: browserPdvCohort,
});
