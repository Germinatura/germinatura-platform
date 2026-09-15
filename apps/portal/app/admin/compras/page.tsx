import { hasPermission } from "@germinatura/auth";
import { redirect } from "next/navigation";
import { SupplierManagement } from "@/components/admin/SupplierManagement";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function ProcurementPage() {
  const user = await requireSession();
  if (!hasPermission(user, "procurement.manage")) redirect("/");
  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header><p className="text-sm font-semibold text-[var(--g-brand-primary)]">Compras</p><h1 className="mt-1 text-3xl font-bold tracking-tight">Fornecedores</h1><p className="mt-2 max-w-2xl text-base text-[var(--g-text-secondary)]">Mantenha os contatos e documentos usados para explicar a origem do estoque. Registros históricos são inativados, sem exclusão.</p></header>
    <SupplierManagement />
  </div></div>;
}
