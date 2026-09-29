import { hasPermission } from "@germinatura/auth";
import { redirect } from "next/navigation";
import { AnnouncementsManagement } from "@/components/admin/AnnouncementsManagement";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AnnouncementsPage() {
  const user = await requireSession();
  if (!hasPermission(user, "communications.manage")) redirect("/");
  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header>
      <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Comunicação</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight">Avisos</h1>
      <p className="mt-2 max-w-2xl text-base text-[var(--g-text-secondary)]">Envie avisos para todos, por perfil ou para pessoas específicas. Eles chegam na central de notificações do Portal.</p>
    </header>
    <AnnouncementsManagement />
  </div></div>;
}
