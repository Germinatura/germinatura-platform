import { hasPermission } from "@germinatura/auth";
import { redirect } from "next/navigation";
import { HistoricalAdjustmentsManagement } from "@/components/admin/HistoricalAdjustmentsManagement";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function HistoricalAdjustmentsPage() {
  const user = await requireSession();
  if (!hasPermission(user, "finance.manage")) redirect("/");
  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header>
      <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Financeiro</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight">Ajustes históricos</h1>
      <p className="mt-2 max-w-3xl text-base text-[var(--g-text-secondary)]">Correções do resultado anterior à operação no Germinatura, sem movimento de caixa, e designações de contrapartidas técnicas do cutover. Nada altera lançamentos, lotes, pagamentos, o extrato PicPay ou a posição de abertura.</p>
    </header>
    <HistoricalAdjustmentsManagement />
  </div></div>;
}
