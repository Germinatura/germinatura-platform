import { hasPermission } from "@germinatura/auth";
import { redirect } from "next/navigation";
import { PicPayStatementImport } from "@/components/admin/PicPayStatementImport";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function StatementImportPage() {
  const user = await requireSession();
  if (!hasPermission(user, "finance.manage")) redirect("/");
  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header>
      <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Financeiro</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight">Extrato PicPay</h1>
      <p className="mt-2 max-w-2xl text-base text-[var(--g-text-secondary)]">Importe o CSV da conta PicPay Empresas para conciliar Pix com as vendas, registrar o Cofrinho e os recebíveis como transferências e revisar o que o sistema não consegue decidir sozinho.</p>
    </header>
    <PicPayStatementImport />
  </div></div>;
}
