import { hasPermission } from "@germinatura/auth";
import { redirect } from "next/navigation";
import { FinanceEntriesManagement } from "@/components/admin/FinanceEntriesManagement";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function FinanceEntriesPage() {
  const user = await requireSession();
  if (!hasPermission(user, "finance.manage")) redirect("/");
  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header>
      <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Financeiro</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight">Lançamentos</h1>
      <p className="mt-2 max-w-2xl text-base text-[var(--g-text-secondary)]">Despesas, outras receitas e transferências entre contas no plano simplificado de categorias. Lançamentos não são editados nem excluídos: correções geram um estorno vinculado.</p>
    </header>
    <FinanceEntriesManagement />
  </div></div>;
}
