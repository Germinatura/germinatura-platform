"use client";

import { managementIndicatorsResponseSchema, type ManagementIndicators } from "@germinatura/contracts";
import { Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const formatMoney = (cents: number) => money.format(cents / 100);
const percent = (bps: number | null) => bps === null ? "—" : `${(bps / 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
const shortDay = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

const channelLabels: Record<keyof ManagementIndicators["byChannel"], string> = {
  PDV: "PDV", ONLINE: "Venda online", RESERVA: "Reserva", RIFA: "Rifa", EVENTO: "Evento", MANUAL: "Lançamento manual",
};
const methodLabels: Record<string, string> = {
  DINHEIRO: "Dinheiro", PIX_AREA: "Área Pix", CREDITO: "Crédito", DEBITO: "Débito", VOUCHER_ALIMENTACAO: "Vale-alimentação",
  VOUCHER_REFEICAO: "Vale-refeição", MAQUININHA: "Maquininha", PAYMENT_LINK: "Link de pagamento", TAP: "PicPay Tap",
  CHECKOUT_API: "Checkout PicPay", PICPAY_WALLET: "Carteira PicPay",
};
const lossReasons: Record<string, string> = {
  DAMAGED: "Danificado", EXPIRED: "Vencido", MISSING: "Extravio", AUTHORIZED_CONSUMPTION: "Consumo autorizado",
  OPERATIONAL_ERROR: "Erro operacional", OTHER: "Outros",
};
const categoryLabels: Record<string, string> = {
  FORNECEDOR: "Fornecedor", TAXAS: "Taxas", MENSALIDADES: "Mensalidades", TRANSPORTE: "Transporte", MATERIAIS: "Materiais",
  REEMBOLSO: "Reembolso", AJUSTE: "Ajuste", OUTROS: "Outros", EVENTO: "Evento",
};

function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date()); }
function shift(day: string, days: number) {
  const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
}
const presets = [
  { label: "Hoje", range: () => ({ from: today(), to: today() }) },
  { label: "Este mês", range: () => ({ from: `${today().slice(0, 8)}01`, to: today() }) },
  { label: "Últimos 30 dias", range: () => ({ from: shift(today(), -29), to: today() }) },
];

/** ADMIN-001 (spec 5.1 e 5.9): indicators of a São Paulo period, derived from ledgers and audited stock. */
export function ManagementIndicatorsView() {
  const [range, setRange] = useState(() => presets[1].range());
  const [data, setData] = useState<ManagementIndicators | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/v1/admin/finance/indicators?${new URLSearchParams(range)}`, { cache: "no-store" });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error((body as { message?: string } | null)?.message ?? "Não foi possível carregar os indicadores.");
      const parsed = managementIndicatorsResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error("Os indicadores retornaram dados inválidos.");
      setData(parsed.data.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar os indicadores."); setData(null); }
    finally { setLoading(false); }
  }, [range]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 200); return () => window.clearTimeout(timer); }, [load]);

  const totals = data?.totals;
  return <div className="grid gap-6">
    <Card className="p-5">
      <form aria-label="Período dos indicadores" className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={(event) => { event.preventDefault(); void load(); }}>
        <Field id="indicators-from" label="De"><Input id="indicators-from" type="date" value={range.from} max={range.to} onChange={(event) => setRange({ ...range, from: event.target.value })} /></Field>
        <Field id="indicators-to" label="Até"><Input id="indicators-to" type="date" value={range.to} min={range.from} onChange={(event) => setRange({ ...range, to: event.target.value })} /></Field>
        <Button type="submit" variant="ghost" disabled={loading}><RefreshCw className="size-4" />Atualizar</Button>
      </form>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Períodos rápidos">{presets.map((preset) => <Button key={preset.label} type="button" size="sm" variant="secondary" onClick={() => setRange(preset.range())}>{preset.label}</Button>)}</div>
      <p className="mt-3 text-xs text-[var(--g-text-muted)]">Dias do calendário de Brasília. Valores calculados pelo servidor a partir dos lançamentos financeiros, do custo real dos lotes e das perdas aplicadas.</p>
    </Card>

    {error && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 p-4 text-sm"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--g-status-danger)]" /><p>{error}</p></div>}
    {loading && !data && <p role="status" className="text-sm">Calculando indicadores…</p>}

    {data && totals && <>
      {!totals.costComplete && <div role="note" className="flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-warning)] bg-[var(--g-status-warning-soft)] p-4 text-sm text-[var(--g-status-warning-foreground)]"><AlertTriangle className="mt-0.5 size-5 shrink-0" /><p>{totals.cogsUnknownUnits + totals.lossesUnknownUnits} unidade(s) saíram de lotes sem custo conhecido. O custo, a margem e o lucro abaixo não incluem essas unidades.</p></div>}
      <section aria-label="Resultado do período" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Receita bruta" value={formatMoney(totals.grossRevenueCents)} hint={`${totals.salesCount} venda(s) · ticket médio ${totals.averageTicketCents === null ? "—" : formatMoney(totals.averageTicketCents)}`} />
        <Kpi label="Receita líquida" value={formatMoney(totals.netRevenueCents)} hint={`estornos ${formatMoney(totals.refundsCents)} · taxas ${formatMoney(totals.feesCents)}`} />
        <Kpi label="Margem bruta" value={formatMoney(totals.grossMarginCents)} hint={`${percent(totals.grossMarginBps)} · custo das mercadorias ${formatMoney(totals.cogsCents)}`} />
        <Kpi label="Lucro operacional estimado" value={formatMoney(totals.operatingProfitCents)} hint={`perdas ${formatMoney(totals.lossesCostCents)} · despesas ${formatMoney(totals.operatingExpensesCents)}`} />
      </section>
      <section aria-label="Caixa do período" className="grid gap-4 sm:grid-cols-3">
        <Kpi label="Saldo financeiro" value={formatMoney(totals.cashBalanceCents)} hint="entradas menos saídas do extrato" />
        <Kpi label="Pagamentos a fornecedores" value={formatMoney(totals.supplierPaymentsCents)} hint="saídas de caixa; o custo entra pela venda" />
        <Kpi label="Receitas manuais" value={formatMoney(totals.manualIncomeCents)} hint="eventos e outras entradas lançadas" />
      </section>

      <Card className="p-5"><h2 className="font-semibold">Receita e margem por dia</h2>
        <DailyChart daily={data.daily} />
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5"><h2 className="font-semibold">Receita por canal</h2><BarList label="Receita por canal" rows={Object.entries(data.byChannel).map(([key, value]) => ({ label: channelLabels[key as keyof typeof channelLabels], value }))} /></Card>
        <Card className="p-5"><h2 className="font-semibold">Receita por forma de pagamento</h2><BarList label="Receita por forma de pagamento" rows={Object.entries(data.byPaymentMethod).map(([key, value]) => ({ label: methodLabels[key] ?? key, value }))} /></Card>
      </div>

      <Card className="overflow-hidden"><h2 className="px-5 pt-5 font-semibold">Produtos mais vendidos</h2>
        <Table label="Produtos mais vendidos" head={["Produto", "Unidades", "Por dia", "Receita", "Custo", "Margem"]} empty="Nenhuma venda de produto no período."
          rows={data.topProducts.map((row) => [row.productName, String(row.units), row.unitsPerDay.toLocaleString("pt-BR"), formatMoney(row.revenueCents),
            row.costCents === null ? "—" : formatMoney(row.costCents) + (row.unknownCostUnits ? ` (+${row.unknownCostUnits} sem custo)` : ""),
            row.marginCents === null ? "incompleta" : formatMoney(row.marginCents)])} />
      </Card>
      <Card className="overflow-hidden"><h2 className="px-5 pt-5 font-semibold">Vendedores</h2>
        <Table label="Vendedores" head={["Vendedor", "Receita", "Vendas", "Estornos", "Unidades", "Ticket médio"]} empty="Nenhuma venda no PDV no período."
          rows={data.sellers.map((row) => [row.sellerName, formatMoney(row.revenueCents), String(row.salesCount), String(row.refundedCount), String(row.units),
            row.averageTicketCents === null ? "—" : formatMoney(row.averageTicketCents)])} />
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="overflow-hidden"><h2 className="px-5 pt-5 font-semibold">Perdas</h2>
          <Table label="Perdas" head={["Produto", "Motivo", "Local", "Unidades", "Custo"]} empty="Nenhuma perda aplicada no período."
            rows={data.losses.map((row) => [row.productName, lossReasons[row.reason] ?? row.reason, row.locationName, String(row.units), row.costCents === null ? "sem custo" : formatMoney(row.costCents)])} />
        </Card>
        <Card className="p-5"><h2 className="font-semibold">Despesas por categoria</h2><BarList label="Despesas por categoria" rows={Object.entries(data.expensesByCategory).map(([key, value]) => ({ label: categoryLabels[key] ?? key, value }))} />
          <h3 className="mt-5 text-sm font-semibold">Pendências agora</h3>
          <ul className="mt-2 space-y-1 text-sm">
            <li>Pagamentos aguardando confirmação: <strong>{data.pending.awaitingPayment}</strong></li>
            <li>Conciliações divergentes: <strong>{data.pending.divergentReconciliations}</strong></li>
            <li>Fechamentos reabertos: <strong>{data.pending.reopenedCloseouts}</strong></li>
            <li>Recuperações de pagamento online abertas: <strong>{data.pending.openPaymentRecoveries}</strong></li>
          </ul>
        </Card>
      </div>
    </>}
  </div>;
}

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <Card className="p-5"><p className="text-sm font-semibold text-[var(--g-text-secondary)]">{label}</p><p className="g-money mt-3 text-2xl font-bold tracking-tight">{value}</p><p className="mt-2 text-xs text-[var(--g-text-muted)]">{hint}</p></Card>;
}

function BarList({ label, rows }: { label: string; rows: Array<{ label: string; value: number }> }) {
  const visible = rows.filter((row) => row.value !== 0).sort((a, b) => b.value - a.value);
  const max = Math.max(1, ...visible.map((row) => Math.abs(row.value)));
  if (!visible.length) return <p className="mt-3 text-sm text-[var(--g-text-muted)]">Nada no período.</p>;
  return <ul aria-label={label} className="mt-3 space-y-2">{visible.map((row) => <li key={row.label} className="text-sm">
    <div className="flex justify-between gap-3"><span>{row.label}</span><span className="g-money font-semibold">{formatMoney(row.value)}</span></div>
    <div aria-hidden className="mt-1 h-2 rounded-full bg-[var(--g-surface-subtle)]"><div className="h-2 rounded-full bg-[var(--g-brand-primary)]" style={{ width: `${(Math.abs(row.value) / max) * 100}%` }} /></div>
  </li>)}</ul>;
}

function DailyChart({ daily }: { daily: ManagementIndicators["daily"] }) {
  const max = Math.max(1, ...daily.map((row) => Math.max(row.revenueCents, row.grossMarginCents)));
  if (daily.every((row) => row.revenueCents === 0 && row.cogsCents === 0)) return <p className="mt-3 text-sm text-[var(--g-text-muted)]">Sem receita no período.</p>;
  return <>
    <div aria-hidden className="mt-4 flex h-40 items-end gap-1 overflow-x-auto">{daily.map((row) => <div key={row.day} className="flex h-full min-w-3 flex-1 flex-col justify-end gap-0.5" title={`${shortDay(row.day)}: receita ${formatMoney(row.revenueCents)}, margem ${formatMoney(row.grossMarginCents)}`}>
      <div className="rounded-t bg-[var(--g-brand-primary)]" style={{ height: `${(Math.max(0, row.revenueCents) / max) * 100}%` }} />
      <div className="rounded bg-[var(--g-accent-aqua)]" style={{ height: `${(Math.max(0, row.grossMarginCents) / max) * 50}%` }} />
    </div>)}</div>
    <p className="mt-2 text-xs text-[var(--g-text-muted)]">Barras escuras: receita bruta. Barras claras: margem bruta (em meia escala).</p>
    <details className="mt-2 text-sm"><summary className="cursor-pointer py-2 font-semibold">Ver valores por dia</summary>
      <Table label="Receita e margem por dia" head={["Dia", "Receita", "Receita líquida", "Custo", "Margem"]} empty=""
        rows={daily.map((row) => [shortDay(row.day), formatMoney(row.revenueCents), formatMoney(row.netRevenueCents), formatMoney(row.cogsCents), formatMoney(row.grossMarginCents)])} />
    </details>
  </>;
}

function Table({ label, head, rows, empty }: { label: string; head: string[]; rows: string[][]; empty: string }) {
  if (!rows.length) return <p className="p-5 text-sm text-[var(--g-text-muted)]">{empty}</p>;
  return <div className="overflow-x-auto"><table aria-label={label} className="mt-3 w-full text-left text-sm">
    <thead className="bg-[var(--g-surface-subtle)] text-xs uppercase tracking-wide text-[var(--g-text-muted)]"><tr>{head.map((cell, index) => <th key={cell} className={`px-5 py-2 font-semibold ${index > 0 ? "text-right" : ""}`}>{cell}</th>)}</tr></thead>
    <tbody className="divide-y divide-[var(--g-border-subtle)]">{rows.map((row, rowIndex) => <tr key={`${row[0]}-${rowIndex}`}>{row.map((cell, index) => <td key={index} className={`px-5 py-2 ${index > 0 ? "g-money whitespace-nowrap text-right" : ""}`}>{cell}</td>)}</tr>)}</tbody>
  </table></div>;
}
