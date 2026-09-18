import { hasPermission } from "@germinatura/auth";
import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { PurchaseOrdersManagement } from "@/components/admin/PurchaseOrdersManagement";
import { requireSession } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function PurchaseOrdersPage() {
  const user = await requireSession();
  if (!hasPermission(user, "procurement.manage")) redirect("/");
  const client = await createSupabaseServerClient();
  const { data, error } = await client.from("products").select("id,name,sku").eq("active", true).order("name").limit(500);
  const products = z.array(z.object({ id: z.uuid(), name: z.string(), sku: z.string() })).safeParse(data);
  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header><Link href="/admin/compras" className="text-sm font-semibold text-[var(--g-brand-primary)]">← Fornecedores</Link><h1 className="mt-2 text-3xl font-bold tracking-tight">Pedidos de compra</h1><p className="mt-2 max-w-2xl text-base text-[var(--g-text-secondary)]">Registre os custos e itens planejados. O pedido não movimenta estoque nem cria obrigação financeira: isso ocorrerá somente no recebimento físico.</p></header>
    {error || !products.success ? <p role="alert" className="rounded-lg bg-[var(--g-status-danger-soft)] p-4">Não foi possível consultar os produtos. Atualize a página.</p> : <PurchaseOrdersManagement products={products.data} />}
  </div></div>;
}
