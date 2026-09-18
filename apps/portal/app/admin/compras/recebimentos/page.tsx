import { hasPermission } from "@germinatura/auth";
import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { PurchaseReceiptsManagement } from "@/components/admin/PurchaseReceiptsManagement";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function PurchaseReceiptsPage({ searchParams }: { searchParams: Promise<{ orderId?: string }> }) {
  const user = await requireSession();
  if (!hasPermission(user, "procurement.manage")) redirect("/");
  const orderId = z.uuid().safeParse((await searchParams).orderId);
  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header><Link href="/admin/compras/pedidos" className="text-sm font-semibold text-[var(--g-brand-primary)]">← Pedidos de compra</Link>
      <h1 className="mt-2 text-3xl font-bold tracking-tight">Recebimento de compras</h1>
      <p className="mt-2 max-w-2xl text-base text-[var(--g-text-secondary)]">Confira fisicamente cada lote. Uma entrega parcial gera entrada central, custo rateado e obrigação a pagar vinculados, sem duplicar efeitos em retentativas.</p>
    </header>
    <PurchaseReceiptsManagement initialOrderId={orderId.success ? orderId.data : ""} />
  </div></div>;
}
