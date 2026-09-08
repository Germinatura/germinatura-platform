import { requireSession } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readPrivateProfile } from "@/lib/private-profile";
import { ProfileEditor } from "@/components/account/ProfileEditor";
export const dynamic = "force-dynamic";
export default async function ProfilePage() {
  const user = await requireSession();
  const profile = await readPrivateProfile(await createSupabaseServerClient(), user.id).catch(() => null);
  if (!profile) {
    return <div role="alert" className="p-8">Não foi possível carregar seu perfil. <a href="/perfil" className="underline">Tentar novamente</a></div>;
  }
  return <ProfileEditor initial={profile} />;
}
