import { hasPermission } from "@germinatura/auth";
import { redirect } from "next/navigation";
import { SellerShiftsReview } from "@/components/admin/SellerShiftsReview";
import { ModuleOffNotice } from "@/components/admin/ModuleOffNotice";
import { requireSession } from "@/lib/auth";
import { isFeatureEnabled } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";

export default async function SellerShiftsPage() {
  const user = await requireSession();
  if (!hasPermission(user, "finance.manage")) redirect("/");
  const moduleEnabled = await isFeatureEnabled("cash_payment");
  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header>
      <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Financeiro</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight">Turnos de caixa</h1>
      <p className="mt-2 max-w-2xl text-base text-[var(--g-text-secondary)]">Confira o dinheiro físico de cada turno: fundo, recebimentos, devoluções em dinheiro e a diferença apurada no fechamento. Turnos fechados não são recalculados.</p>
    </header>
    {!moduleEnabled && <ModuleOffNotice flag="cash_payment">O PDV não recebe em dinheiro nem abre turnos novos. Turnos já abertos ainda podem ser fechados e conferidos aqui.</ModuleOffNotice>}
    <SellerShiftsReview />
  </div></div>;
}
