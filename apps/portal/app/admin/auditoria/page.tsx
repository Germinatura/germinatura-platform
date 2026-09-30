import { hasPermission } from "@germinatura/auth";
import { redirect } from "next/navigation";
import { AuditExplorer } from "@/components/admin/AuditExplorer";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const user = await requireSession();
  if (!hasPermission(user, "audit.read")) redirect("/");
  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header>
      <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Administração</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight">Auditoria</h1>
      <p className="mt-2 max-w-2xl text-base text-[var(--g-text-secondary)]">Investigue quem fez o quê, quando e em qual registro, e siga uma operação pela venda, pagamento, estoque e financeiro. Nada aqui altera o histórico.</p>
    </header>
    <AuditExplorer />
  </div></div>;
}
