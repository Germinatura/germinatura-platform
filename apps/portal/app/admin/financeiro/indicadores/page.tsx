import { hasPermission } from "@germinatura/auth";
import { redirect } from "next/navigation";
import { FinanceBalancesSummary } from "@/components/admin/FinanceBalancesSummary";
import { ManagementIndicatorsView } from "@/components/admin/ManagementIndicatorsView";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function ManagementIndicatorsPage() {
  const user = await requireSession();
  if (!hasPermission(user, "finance.manage")) redirect("/");
  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header>
      <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Financeiro</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight">Indicadores</h1>
      <p className="mt-2 max-w-2xl text-base text-[var(--g-text-secondary)]">Receita, custo real, perdas, despesas, margem e lucro de qualquer período, por canal, forma de pagamento, produto e vendedor.</p>
    </header>
    <FinanceBalancesSummary />
    <ManagementIndicatorsView />
  </div></div>;
}
