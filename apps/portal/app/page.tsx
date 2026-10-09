import { requireSession } from "@/lib/auth";
import { AdminOverview } from "@/components/admin/AdminOverview";
import { ConsolidatedOverview } from "@/components/admin/ConsolidatedOverview";
import { ConsumerHome } from "@/components/consumer/ConsumerHome";
export const dynamic = "force-dynamic";
export default async function HomePage() {
  const user = await requireSession();
  // ADR 0011 (PR 4): in "Todas as turmas" ADMIN_MASTER sees the cohorts side by side, never one mixed overview.
  if (user.adminMaster && user.cohortMode === "ALL") return <ConsolidatedOverview name={user.name} cohorts={user.cohorts} />;
  return user.roles.includes("ADMIN") || user.adminMaster ? <AdminOverview name={user.name} /> : <ConsumerHome user={user} />;
}
