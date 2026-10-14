import { redirect } from "next/navigation";
import { CohortsManager } from "@/components/admin/CohortsManager";
import { requireSession } from "@/lib/auth";
import { toCohortOverview } from "@/lib/cohort-admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** ADR 0011: cohort administration, ADMIN_MASTER only (global; available in "Todas as turmas"). */
export default async function AdminCohortsPage() {
  const user = await requireSession();
  if (!user.adminMaster) redirect("/");
  const { data, error } = await (await createSupabaseServerClient()).rpc("cohort_overview");
  return <CohortsManager initial={error ? [] : toCohortOverview(data)} unavailable={Boolean(error)} />;
}
