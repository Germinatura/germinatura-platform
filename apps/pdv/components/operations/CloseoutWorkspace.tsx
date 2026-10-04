"use client";

import type { PublicCatalogProduct, SellerCloseoutResponse } from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, CheckCircle2, ClipboardCheck, PackageCheck } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { createSellerCloseout, formatMoney, type InventoryContext } from "@/lib/operations";

type CloseoutData = SellerCloseoutResponse["data"];

function localDateTime(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function startOfToday() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return localDateTime(now);
}

const operationKey = () => `pdv-closeout:${crypto.randomUUID()}`;

export function CloseoutWorkspace({
  catalog,
  inventory,
  online,
}: {
  catalog: PublicCatalogProduct[];
  inventory: InventoryContext;
  online: boolean;
}) {
  const sellerLocation = inventory.locations.find((location) => location.type === "SELLER") ?? null;
  const products = useMemo(() => {
    if (!sellerLocation) return [];
    const catalogById = new Map(catalog.map((product) => [product.id, product]));
    return Object.entries(inventory.onHandByLocationAndProduct)
      .filter(([key]) => key.startsWith(`${sellerLocation.id}:`))
      .map(([key, expectedQuantity]) => {
        const productId = key.slice(sellerLocation.id.length + 1);
        const product = catalogById.get(productId);
        return { productId, expectedQuantity, name: product?.name ?? `Produto ${productId.slice(0, 8)}`, sku: product?.sku ?? productId };
      })
      .sort((left, right) => left.name.localeCompare(right.name, "pt-BR"));
  }, [catalog, inventory.onHandByLocationAndProduct, sellerLocation]);
  const [periodStart, setPeriodStart] = useState(startOfToday);
  const [periodEnd, setPeriodEnd] = useState(() => localDateTime(new Date()));
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [justification, setJustification] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CloseoutData | null>(null);
  const idempotencyKey = useRef(operationKey());
  const { showToast } = useToast();

  const complete = products.length > 0 && products.every((product) => {
    const value = counts[product.productId];
    return value !== undefined && /^\d+$/.test(value) && Number.isSafeInteger(Number(value));
  });

  async function submit() {
    if (!sellerLocation || !complete || !online || busy) return;
    setBusy(true); setError("");
    try {
      const closeout = await createSellerCloseout(
        new Date(periodStart).toISOString(),
        new Date(periodEnd).toISOString(),
        products.map((product) => ({ productId: product.productId, countedQuantity: Number(counts[product.productId]) })),
        justification.trim() || null,
        idempotencyKey.current,
      );
      setResult(closeout);
      showToast("Fechamento registrado com sucesso.", "success");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Não foi possível concluir o fechamento.";
      setError(message); showToast(message, "error");
    } finally { setBusy(false); }
  }

  if (!sellerLocation) return <CloseoutEmpty title="Localização do vendedor indisponível" description="Peça a um administrador para ativar sua localização antes de fechar a operação." />;
  if (products.length === 0) return <CloseoutEmpty title="Nenhum item para contar" description="O fechamento exige a contagem completa do estoque vinculado à sua localização." />;
  if (result) return <CloseoutResult result={result} products={products} />;

  return <div className="mx-auto max-w-4xl space-y-5">
    {error && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 bg-[var(--g-surface-default)] p-4 text-sm"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--g-status-danger)]" /><div><p className="font-semibold">Não foi possível registrar o fechamento</p><p className="mt-1 text-[var(--g-text-secondary)]">{error}</p></div></div>}
    <Card className="p-5 md:p-6">
      <div className="flex items-start gap-3"><ClipboardCheck className="mt-0.5 size-6 text-[var(--g-focus-ring)]" /><div><h2 className="text-lg font-semibold">Período da operação</h2><p className="mt-1 text-sm leading-6 text-[var(--g-text-secondary)]">As vendas e confirmações deste período serão comparadas automaticamente.</p></div></div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field id="closeout-start" label="Início"><Input id="closeout-start" type="datetime-local" value={periodStart} max={periodEnd} onChange={(event) => { setPeriodStart(event.target.value); idempotencyKey.current = operationKey(); }} /></Field>
        <Field id="closeout-end" label="Fim"><Input id="closeout-end" type="datetime-local" value={periodEnd} min={periodStart} max={localDateTime(new Date())} onChange={(event) => { setPeriodEnd(event.target.value); idempotencyKey.current = operationKey(); }} /></Field>
      </div>
    </Card>
    <Card className="overflow-hidden"><div className="border-b border-[var(--g-border-subtle)] p-5 md:px-6"><h2 className="font-semibold">Contagem física</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">Informe todos os itens da localização {sellerLocation.name}.</p></div><div className="divide-y divide-[var(--g-border-subtle)]">{products.map((product) => <div key={product.productId} className="grid gap-3 p-5 sm:grid-cols-[minmax(0,1fr)_9rem] sm:items-center md:px-6"><div><p className="font-semibold">{product.name}</p><p className="mt-1 text-xs text-[var(--g-text-muted)]">SKU {product.sku} · saldo do sistema {product.expectedQuantity}</p></div><Field id={`count-${product.productId}`} label="Quantidade contada"><Input id={`count-${product.productId}`} type="number" inputMode="numeric" min={0} step={1} value={counts[product.productId] ?? ""} onChange={(event) => { setCounts((current) => ({ ...current, [product.productId]: event.target.value })); idempotencyKey.current = operationKey(); }} /></Field></div>)}</div></Card>
    <Card className="p-5 md:p-6"><Field id="closeout-justification" label="Justificativa de divergência" description="Obrigatória se pagamentos ou estoque não coincidirem. Se tudo estiver correto, deixe em branco."><textarea id="closeout-justification" rows={4} minLength={4} maxLength={500} value={justification} onChange={(event) => { setJustification(event.target.value); idempotencyKey.current = operationKey(); }} className="mt-2 w-full rounded-[var(--g-radius-control)] border border-[var(--g-border-default)] bg-[var(--g-surface-default)] px-4 py-3 text-sm focus-visible:outline-3 focus-visible:outline-[var(--g-focus-ring)]" /></Field><div className="mt-5 rounded-[var(--g-radius-control)] bg-[var(--g-surface-subtle)] p-4 text-sm leading-6 text-[var(--g-text-secondary)]">O fechamento cria um registro imutável. Somente Admin ou Financeiro pode reabri-lo, sempre com motivo e auditoria.</div><Button variant="operation" size="lg" className="mt-5 w-full" disabled={!online || !complete || !periodStart || !periodEnd} loading={busy} onClick={() => void submit()}>Finalizar fechamento</Button></Card>
  </div>;
}

function CloseoutResult({ result, products }: { result: CloseoutData; products: Array<{ productId: string; name: string }> }) {
  const names = new Map(products.map((product) => [product.productId, product.name]));
  const divergent = result.paymentDifferenceCents !== 0 || result.stockDifferenceUnits !== 0;
  return <div className="mx-auto max-w-4xl space-y-5"><Card className="overflow-hidden"><div className="bg-[var(--g-status-success-soft)] p-7 text-center text-[var(--g-status-success-foreground)]"><CheckCircle2 className="mx-auto size-12" /><h2 className="mt-3 text-2xl font-bold">Fechamento registrado</h2><p className="mt-1 text-sm">O resumo ficou salvo e não pode ser editado.</p></div><div className="grid gap-4 p-5 sm:grid-cols-2 md:grid-cols-4 md:p-6"><Metric label="Vendas" value={String(result.confirmedSalesCount)} /><Metric label="Total vendido" value={formatMoney(result.confirmedSalesTotalCents)} /><Metric label="Pagamentos" value={formatMoney(result.paymentTotalCents)} /><Metric label="Divergências" value={divergent ? "Com justificativa" : "Nenhuma"} warning={divergent} /></div></Card>
    <Card className="p-5 md:p-6"><h3 className="font-semibold">Pagamentos por canal</h3><div className="mt-4 space-y-3">{result.paymentSummaries.length === 0 ? <p className="text-sm text-[var(--g-text-muted)]">Nenhum pagamento confirmado no período.</p> : result.paymentSummaries.map((summary) => <div key={summary.integrationChannel} className="flex justify-between gap-4 text-sm"><span className="text-[var(--g-text-secondary)]">{summary.integrationChannel === "MAQUININHA" ? "Maquininha" : summary.integrationChannel === "PIX_AREA" ? "Área Pix" : summary.integrationChannel} · {summary.paymentCount}</span><strong className="g-money">{formatMoney(summary.totalCents)}</strong></div>)}</div></Card>
    <Card className="p-5 md:p-6"><h3 className="font-semibold">Conferência de estoque</h3><div className="mt-4 space-y-3">{result.stockCounts.map((stock) => <div key={stock.productId} className="flex items-center justify-between gap-4 text-sm"><span className="min-w-0 truncate text-[var(--g-text-secondary)]">{names.get(stock.productId) ?? stock.productId}</span><Badge tone={stock.differenceQuantity === 0 ? "success" : "warning"}>{stock.countedQuantity} contados · {stock.differenceQuantity === 0 ? "correto" : `${stock.differenceQuantity > 0 ? "+" : ""}${stock.differenceQuantity}`}</Badge></div>)}</div>{result.justification && <div className="mt-5 border-t border-[var(--g-border-subtle)] pt-5"><p className="text-xs font-semibold uppercase tracking-wide text-[var(--g-text-muted)]">Justificativa</p><p className="mt-2 text-sm leading-6">{result.justification}</p></div>}</Card>
  </div>;
}

function Metric({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return <div className="rounded-[var(--g-radius-control)] bg-[var(--g-surface-subtle)] p-4"><p className="text-xs text-[var(--g-text-muted)]">{label}</p><p className={`g-money mt-1 font-bold ${warning ? "text-[var(--g-status-warning-foreground)]" : ""}`}>{value}</p></div>;
}

function CloseoutEmpty({ title, description }: { title: string; description: string }) {
  return <Card className="mx-auto grid min-h-64 max-w-3xl place-items-center p-8 text-center"><div><PackageCheck className="mx-auto size-10 text-[var(--g-text-muted)]" /><h2 className="mt-4 font-semibold">{title}</h2><p className="mt-2 max-w-md text-sm leading-6 text-[var(--g-text-secondary)]">{description}</p></div></Card>;
}
