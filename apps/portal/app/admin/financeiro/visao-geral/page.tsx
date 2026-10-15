import { hasPermission } from "@germinatura/auth";
import { redirect } from "next/navigation";
import { FinanceOverview } from "@/components/admin/FinanceOverview";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function FinanceOverviewPage() {
  const user = await requireSession();
  if (!hasPermission(user, "finance.manage")) redirect("/");
  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header>
      <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Financeiro</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight">Visão financeira</h1>
      <p className="mt-2 max-w-3xl text-base text-[var(--g-text-secondary)]">Separa o que é dinheiro disponível, o que ainda vai entrar, o que está comprometido e o resultado do período. A apresentação gerencial nunca muda o resultado oficial, e a ponte mostra como o resultado vira posição financeira.</p>
    </header>
    <FinanceOverview />
  </div></div>;
}
