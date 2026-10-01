import { hasPermission } from "@germinatura/auth";
import { redirect } from "next/navigation";
import { PortalEventsManagement } from "@/components/admin/PortalEventsManagement";
import { PortalHighlightSettings } from "@/components/admin/PortalHighlightSettings";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function PortalEventsAdminPage() {
  const user = await requireSession();
  if (!hasPermission(user, "communications.manage")) redirect("/");
  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header>
      <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Comunicação</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight">Eventos e campanhas</h1>
      <p className="mt-2 max-w-2xl text-base text-[var(--g-text-secondary)]">Cadastre festas, ações de venda e campanhas temáticas com data, local, capa e chamada para ação, ligadas a produtos, promoções e vendedores.</p>
    </header>
    <PortalHighlightSettings />
    <PortalEventsManagement />
  </div></div>;
}
