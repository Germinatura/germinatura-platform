import { PortalEventsBoard } from "@/components/events/PortalEvents";
import { requireSession } from "@/lib/auth";
import { isFeatureEnabled } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";

export default async function EventsPage() {
  await requireSession();
  const enabled = await isFeatureEnabled("events");
  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header>
      <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Formatura</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight">Eventos e campanhas</h1>
      <p className="mt-2 max-w-2xl text-base text-[var(--g-text-secondary)]">Festas, ações de venda e datas importantes da comissão, num só lugar. Os eventos encerrados ficam no arquivo.</p>
    </header>
    {enabled ? <PortalEventsBoard /> : <p role="status" className="rounded-[var(--g-radius-card)] border border-[var(--g-border-subtle)] bg-[var(--g-surface-default)] p-6 text-sm text-[var(--g-text-secondary)]">Eventos e campanhas não estão disponíveis no momento.</p>}
  </div></div>;
}
