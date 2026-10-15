import { hasPermission } from "@germinatura/auth";
import { redirect } from "next/navigation";
import { FinanceSalesManagement } from "@/components/admin/FinanceSalesManagement";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function FinanceSalesPage() {
  const user = await requireSession();
  if (!hasPermission(user, "sales.read.all")) redirect("/");
  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header>
      <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Financeiro</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight">Vendas</h1>
      <p className="mt-2 max-w-2xl text-base text-[var(--g-text-secondary)]">Consulte todas as vendas por situação, canal e período. Estornos voltam o estoque e registram como o valor retornou ao cliente, inclusive a devolução em dinheiro pelo caixa de um turno aberto.</p>
    </header>
    <FinanceSalesManagement cohorts={user.cohortMode === "ALL" ? user.cohorts : undefined} />
  </div></div>;
}
