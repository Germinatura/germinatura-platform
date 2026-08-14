import type { AppRole } from "@germinatura/contracts";
import { createSupabaseAdminClient } from "./server";

export async function linkLegacyIdentity(authId: string, legacyUserId: string, role: AppRole) {
  const admin = createSupabaseAdminClient();
  const { error: profileError } = await admin.from("profiles").update({ legacy_user_id: legacyUserId }).eq("id", authId);
  if (profileError) throw profileError;
  const { data: roleRow, error: roleError } = await admin.from("roles").select("id").eq("key", role).single();
  if (roleError || !roleRow) throw roleError ?? new Error(`Papel não encontrado: ${role}`);
  const { error: deleteError } = await admin.from("user_roles").delete().eq("user_id", authId);
  if (deleteError) throw deleteError;
  const { error: insertError } = await admin.from("user_roles").insert({ user_id: authId, role_id: roleRow.id });
  if (insertError) throw insertError;
}

export async function findAuthIdByLegacyUser(legacyUserId: string): Promise<string | null> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.from("profiles").select("id").eq("legacy_user_id", legacyUserId).maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}
