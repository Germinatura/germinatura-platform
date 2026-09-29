import { hasPermission } from "@germinatura/auth";
import { redirect } from "next/navigation";
import { ReservationsManagement } from "@/components/admin/ReservationsManagement";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function ReservationsAdminPage() {
  const user = await requireSession();
  if (!hasPermission(user, "reservations.manage.all")) redirect("/");
  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header>
      <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Reservas</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight">Gestão de reservas</h1>
      <p className="mt-2 max-w-2xl text-base text-[var(--g-text-secondary)]">Separe as reservas, avise que estão prontas para retirada e acompanhe prazos. O preço e o estoque ficam congelados desde a reserva.</p>
    </header>
    <ReservationsManagement />
  </div></div>;
}
