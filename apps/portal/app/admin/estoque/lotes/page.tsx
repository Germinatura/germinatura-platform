import { hasPermission } from "@germinatura/auth";
import { redirect } from "next/navigation";
import { InventoryLotTraceability } from "@/components/admin/InventoryLotTraceability";
import { requireSession } from "@/lib/auth";

export const dynamic="force-dynamic";
export default async function InventoryLotsPage(){const user=await requireSession();if(!hasPermission(user,"inventory.manage"))redirect("/");return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6"><header><p className="text-sm font-semibold text-[var(--g-brand-primary)]">Estoque</p><h1 className="mt-1 text-3xl font-bold tracking-tight">Rastreabilidade por lote</h1><p className="mt-2 max-w-3xl text-base text-[var(--g-text-secondary)]">Siga a origem, as localizações, o custo real e cada movimento até a venda ou correção. Custos desconhecidos permanecem identificados como tal.</p></header><InventoryLotTraceability/></div></div>;}
