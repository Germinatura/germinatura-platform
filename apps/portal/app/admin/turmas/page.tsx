import { redirect } from "next/navigation";
import { CohortsManager } from "@/components/admin/CohortsManager";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** ADR 0011: cohort administration, ADMIN_MASTER only (global; available in "Todas as turmas"). */
export default async function AdminCohortsPage() {
  const user = await requireSession();
  if (!user.adminMaster) redirect("/");
  return <CohortsManager initial={user.cohorts} />;
}
