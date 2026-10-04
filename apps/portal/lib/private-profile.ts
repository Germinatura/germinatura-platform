import { privateProfileSchema } from "@germinatura/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function readPrivateProfile(client: SupabaseClient, id: string) {
  const [identity, preferences] = await Promise.all([
    client.from("profiles").select("id,email,username,display_name,avatar_path").eq("id", id).single(),
    client.from("profile_preferences").select("revision,bio,class_name,sweet_preferences").eq("profile_id", id).maybeSingle(),
  ]);
  if (identity.error || preferences.error || !identity.data) throw new Error("PROFILE_UNAVAILABLE");
  const profile = identity.data;
  const photo = typeof profile.avatar_path === "string"
    ? await client.storage.from("profile-photos").createSignedUrl(profile.avatar_path, 900) : null;
  return privateProfileSchema.parse({
    id: profile.id, email: profile.email, username: profile.username, displayName: profile.display_name,
    avatarPath: profile.avatar_path, avatarUrl: photo?.data?.signedUrl ?? null,
    revision: preferences.data?.revision ?? 0, bio: preferences.data?.bio ?? "",
    className: preferences.data?.class_name ?? "", sweetPreferences: preferences.data?.sweet_preferences ?? [],
  });
}
