import { createApiClient } from "@germinatura/contracts";
import { getSupabaseBrowserClient } from "@/lib/supabase";

export const apiFetch = createApiClient({
  getAccessToken: async () => {
    const { data } = await getSupabaseBrowserClient().auth.getSession();
    return data.session?.access_token ?? null;
  },
});
