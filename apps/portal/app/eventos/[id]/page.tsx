import Link from "next/link";
import { PortalEventPage } from "@/components/events/PortalEvents";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <Link href="/eventos" className="text-sm font-semibold text-[var(--g-brand-primary)]">← Eventos e campanhas</Link>
    <h1 className="sr-only">Evento</h1>
    <PortalEventPage eventId={id} />
  </div></div>;
}
