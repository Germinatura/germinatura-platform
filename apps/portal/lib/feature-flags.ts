import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** Reads one functional switch. The database enforces it on mutations; this only shapes what pages show. */
export async function isFeatureEnabled(key: string, client?: SupabaseClient): Promise<boolean> {
  const supabase = client ?? await createSupabaseServerClient();
  const { data, error } = await supabase.from("feature_flags").select("enabled").eq("key", key).maybeSingle();
  // An unreadable flag counts as on: hiding history by mistake is worse than showing a screen the database guards.
  if (error || !data) return true;
  return data.enabled === true;
}
