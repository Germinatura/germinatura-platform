import { hasPermission } from "@germinatura/auth";
import { Badge, Card, Input } from "@germinatura/ui";
import { Boxes, CircleAlert, PackageOpen, Warehouse } from "lucide-react";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const locationsSchema = z.array(z.object({ id: z.uuid(), name: z.string(), location_type: z.enum(["CENTRAL", "SELLER"]), active: z.boolean() }));
const balancesSchema = z.array(z.object({ location_id: z.uuid(), product_id: z.uuid(), on_hand_quantity: z.number().int(), reserved_quantity: z.number().int(), available_quantity: z.number().int() }));
const productsSchema = z.array(z.object({ id: z.uuid(), sku: z.string(), name: z.string(), active: z.boolean() }));
const movementsSchema = z.array(z.object({ id: z.uuid(), movement_type: z.string(), from_location_id: z.uuid().nullable(), to_location_id: z.uuid().nullable(), reason: z.string(), created_at: z.string() }));
const movementItemsSchema = z.array(z.object({ movement_id: z.uuid(), product_id: z.uuid(), quantity: z.number().int() }));
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
const movementLabels: Record<string, string> = { SALDO_INICIAL: "Saldo inicial", ENTRADA_COMPRA: "Entrada", TRANSFERENCIA: "Transferência", VENDA: "Venda", RESERVA: "Reserva", LIBERACAO_RESERVA: "Liberação", PERDA: "Perda", VENCIMENTO: "Vencimento", DEVOLUCAO: "Devolução", AJUSTE_POSITIVO: "Ajuste positivo", AJUSTE_NEGATIVO: "Ajuste negativo", CANCELAMENTO_VENDA: "Cancelamento" };

export default async function InventoryAdminPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireSession();
  if (!hasPermission(user, "inventory.manage")) redirect("/");
  const params = await searchParams;
  const query = params.q?.trim().toLocaleLowerCase("pt-BR") ?? "";
  const client = await createSupabaseServerClient();
  const [locationsResult, balancesResult, productsResult, movementsResult] = await Promise.all([
    client.from("stock_locations").select("id,name,location_type,active").order("name"),
    client.from("inventory_balances").select("location_id,product_id,on_hand_quantity,reserved_quantity,available_quantity"),
    client.from("products").select("id,sku,name,active").order("name"),
    client.from("stock_movements").select("id,movement_type,from_location_id,to_location_id,reason,created_at").order("created_at", { ascending: false }).limit(12),
  ]);
  const parsedLocations = locationsSchema.safeParse(locationsResult.data);
  const parsedBalances = balancesSchema.safeParse(balancesResult.data);
  const parsedProducts = productsSchema.safeParse(productsResult.data);
  const parsedMovements = movementsSchema.safeParse(movementsResult.data);
  const movementIds = parsedMovements.success ? parsedMovements.data.map((movement) => movement.id) : [];
  const movementItemsResult = movementIds.length ? await client.from("stock_movement_items").select("movement_id,product_id,quantity").in("movement_id", movementIds) : { data: [], error: null };
  const parsedItems = movementItemsSchema.safeParse(movementItemsResult.data);
  const unavailable = Boolean(locationsResult.error || balancesResult.error || productsResult.error || movementsResult.error || movementItemsResult.error || !parsedLocations.success || !parsedBalances.success || !parsedProducts.success || !parsedMovements.success || !parsedItems.success);
  const locations = parsedLocations.success ? parsedLocations.data : [];
  const balances = parsedBalances.success ? parsedBalances.data : [];
  const products = parsedProducts.success ? parsedProducts.data : [];
  const movements = parsedMovements.success ? parsedMovements.data : [];
  const items = parsedItems.success ? parsedItems.data : [];
  const locationById = new Map(locations.map((location) => [location.id, location]));
  const productById = new Map(products.map((product) => [product.id, product]));
  const filtered = balances.filter((balance) => { const product = productById.get(balance.product_id); const location = locationById.get(balance.location_id); return !query || `${product?.name ?? ""} ${product?.sku ?? ""} ${location?.name ?? ""}`.toLocaleLowerCase("pt-BR").includes(query); });
  const totals = balances.reduce((sum, balance) => ({ onHand: sum.onHand + balance.on_hand_quantity, reserved: sum.reserved + balance.reserved_quantity, available: sum.available + balance.available_quantity }), { onHand: 0, reserved: 0, available: 0 });

  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header><p className="text-sm font-semibold text-[var(--g-brand-primary)]">Estoque</p><h1 className="mt-1 text-3xl font-bold tracking-tight">Saldos por localização</h1><p className="mt-2 max-w-2xl text-base text-[var(--g-text-secondary)]">Acompanhe saldo físico, reservas e movimentos imutáveis. Correções devem usar movimentos compensatórios, nunca edição direta.</p></header>
    {unavailable && <div role="alert" className="rounded-[var(--g-radius-control)] bg-[var(--g-status-danger-soft)] p-4 text-sm text-[var(--g-status-danger-foreground)]">Não foi possível consultar todo o estoque. Não use os totais abaixo para fechamento enquanto este aviso estiver visível.</div>}
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Resumo do estoque">
      <Summary icon={Boxes} label="Saldo físico" value={totals.onHand} />
      <Summary icon={CircleAlert} label="Reservado" value={totals.reserved} tone="warning" />
      <Summary icon={PackageOpen} label="Disponível" value={totals.available} tone="success" />
      <Summary icon={Warehouse} label="Localizações ativas" value={locations.filter((location) => location.active).length} />
    </section>
    <Card className="overflow-hidden"><div className="flex flex-col gap-4 border-b border-[var(--g-border-subtle)] p-5 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-lg font-bold">Posição atual</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">{filtered.length} saldos por produto e localização</p></div><form className="flex w-full gap-2 sm:max-w-md"><label className="flex-1"><span className="sr-only">Buscar saldo</span><Input name="q" defaultValue={params.q ?? ""} placeholder="Produto, SKU ou localização" /></label><button className="min-h-11 rounded-[var(--g-radius-control)] bg-[var(--g-brand-primary)] px-4 text-sm font-semibold text-white">Buscar</button></form></div>
      {!unavailable && filtered.length === 0 ? <Empty /> : !unavailable && <><div className="hidden overflow-x-auto md:block"><table className="w-full text-left text-sm"><thead className="bg-[var(--g-surface-subtle)] text-xs uppercase tracking-wide text-[var(--g-text-muted)]"><tr><th className="px-6 py-3">Produto</th><th className="px-6 py-3">Localização</th><th className="px-6 py-3 text-right">Físico</th><th className="px-6 py-3 text-right">Reservado</th><th className="px-6 py-3 text-right">Disponível</th></tr></thead><tbody className="divide-y divide-[var(--g-border-subtle)]">{filtered.map((balance) => { const product = productById.get(balance.product_id); const location = locationById.get(balance.location_id); return <tr key={`${balance.location_id}-${balance.product_id}`} className="hover:bg-[var(--g-surface-hover)]"><td className="px-6 py-4"><p className="font-semibold">{product?.name ?? "Produto indisponível"}</p><p className="mt-1 text-xs text-[var(--g-text-muted)]">{product?.sku}</p></td><td className="px-6 py-4"><p>{location?.name ?? "Localização indisponível"}</p><p className="mt-1 text-xs text-[var(--g-text-muted)]">{location?.location_type === "CENTRAL" ? "Central" : "Vendedor"}</p></td><td className="px-6 py-4 text-right tabular-nums">{balance.on_hand_quantity}</td><td className="px-6 py-4 text-right tabular-nums">{balance.reserved_quantity}</td><td className="px-6 py-4 text-right font-semibold tabular-nums">{balance.available_quantity}</td></tr>; })}</tbody></table></div><div className="divide-y divide-[var(--g-border-subtle)] md:hidden">{filtered.map((balance) => { const product = productById.get(balance.product_id); const location = locationById.get(balance.location_id); return <article key={`${balance.location_id}-${balance.product_id}`} className="p-5"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{product?.name ?? "Produto indisponível"}</h3><p className="mt-1 text-xs text-[var(--g-text-muted)]">{product?.sku} · {location?.name}</p></div><Badge tone={balance.available_quantity > 0 ? "success" : "warning"}>{balance.available_quantity} disponível</Badge></div><dl className="mt-4 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-[var(--g-text-muted)]">Saldo físico</dt><dd className="mt-1 font-semibold tabular-nums">{balance.on_hand_quantity}</dd></div><div><dt className="text-[var(--g-text-muted)]">Reservado</dt><dd className="mt-1 font-semibold tabular-nums">{balance.reserved_quantity}</dd></div></dl></article>; })}</div></>}
    </Card>
    <Card className="overflow-hidden"><div className="border-b border-[var(--g-border-subtle)] p-5"><h2 className="text-lg font-bold">Movimentos recentes</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">Histórico imutável das últimas movimentações.</p></div>{!unavailable && movements.length === 0 ? <div className="p-6 text-sm text-[var(--g-text-secondary)]">Ainda não há movimentos registrados.</div> : !unavailable && <div className="divide-y divide-[var(--g-border-subtle)]">{movements.map((movement) => { const movementItems = items.filter((item) => item.movement_id === movement.id); const path = movement.from_location_id && movement.to_location_id ? `${locationById.get(movement.from_location_id)?.name ?? "Origem"} → ${locationById.get(movement.to_location_id)?.name ?? "Destino"}` : movement.from_location_id ? locationById.get(movement.from_location_id)?.name : locationById.get(movement.to_location_id ?? "")?.name; return <article key={movement.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex flex-wrap items-center gap-2"><Badge tone={movement.movement_type.includes("NEGATIVO") || ["PERDA", "VENCIMENTO"].includes(movement.movement_type) ? "danger" : "info"}>{movementLabels[movement.movement_type] ?? movement.movement_type}</Badge><span className="text-sm text-[var(--g-text-muted)]">{dateTime.format(new Date(movement.created_at))}</span></div><p className="mt-2 text-sm font-semibold">{movementItems.map((item) => `${productById.get(item.product_id)?.name ?? "Produto"}: ${item.quantity}`).join(", ")}</p><p className="mt-1 text-xs text-[var(--g-text-muted)]">{path} · {movement.reason}</p></div></article>; })}</div>}
    </Card>
  </div></div>;
}

function Summary({ icon: Icon, label, value, tone = "brand" }: { icon: typeof Boxes; label: string; value: number; tone?: "brand" | "warning" | "success" }) { const styles = tone === "warning" ? "bg-[var(--g-status-warning-soft)] text-[var(--g-status-warning-foreground)]" : tone === "success" ? "bg-[var(--g-status-success-soft)] text-[var(--g-status-success-foreground)]" : "bg-[var(--g-brand-primary-soft)] text-[var(--g-brand-primary)]"; return <Card className="p-5"><div className="flex items-start justify-between"><p className="text-sm font-semibold text-[var(--g-text-secondary)]">{label}</p><span className={`flex size-10 items-center justify-center rounded-[var(--g-radius-control)] ${styles}`}><Icon className="size-5" /></span></div><p className="mt-5 text-3xl font-bold tabular-nums">{value}</p></Card>; }
function Empty() { return <div className="p-10 text-center"><Boxes className="mx-auto size-10 text-[var(--g-text-muted)]" /><p className="mt-4 font-semibold">Nenhum saldo encontrado</p><p className="mt-1 text-sm text-[var(--g-text-secondary)]">Ajuste a busca ou confira se o produto possui uma localização de estoque.</p></div>; }
