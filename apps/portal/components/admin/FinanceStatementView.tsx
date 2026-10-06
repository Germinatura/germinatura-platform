"use client";

import { financeAccountSchema, financeStatementResponseSchema, type FinanceStatementNature, type FinanceStatementResponse } from "@germinatura/contracts";
import { Badge, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, Download, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { financeAccountLabels, financeCategoryLabels } from "@/lib/finance-labels";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const formatMoney = (cents: number) => money.format(cents / 100);
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const formatDay = (value: string) => value.split("-").reverse().join("/");
// Spec 5.8: what kind of money movement each row is. Internal transfers and the opening position are never revenue.
const natureLabels: Record<FinanceStatementNature, { label: string; tone: "success" | "danger" | "info" | "neutral" | "warning" }> = {
  RECEITA: { label: "Receita", tone: "success" }, DESPESA: { label: "Despesa", tone: "danger" },
  TRANSFERENCIA_INTERNA: { label: "Transferência interna", tone: "info" }, CONCILIACAO: { label: "Conciliação", tone: "info" },
  ESTORNO: { label: "Estorno", tone: "warning" }, SALDO_ABERTURA: { label: "Saldo de abertura", tone: "neutral" },
};
const sourceLabels: Record<string, string> = { SALE: "Venda", PAYABLE: "Fornecedor", MANUAL: "Manual", IMPORT: "Extrato PicPay", OPENING: "Abertura" };

/** FIN-006: consolidated statement by treasury account and category, exportable as CSV. */
export function FinanceStatementView() {
  const [period, setPeriod] = useState({ from: `${today().slice(0, 8)}01`, to: today() });
  const [statement, setStatement] = useState<FinanceStatementResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/v1/admin/finance/statement?${new URLSearchParams(period)}`, { cache: "no-store" });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? body.message : null;
        throw new Error(message ?? "Não foi possível carregar o extrato.");
      }
      const parsed = financeStatementResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error("O extrato retornou dados inválidos.");
      setStatement(parsed.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar o extrato."); }
    finally { setLoading(false); }
  }, [period]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 250); return () => window.clearTimeout(timer); }, [load]);

  const categories = Object.entries(statement?.totals.byCategory ?? {}).sort(([, left], [, right]) => right - left);
  return <div className="grid gap-6">
    <Card className="p-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-4">
          <Field id="statement-from" label="De"><Input id="statement-from" type="date" value={period.from} onChange={(event) => setPeriod({ ...period, from: event.target.value })} /></Field>
          <Field id="statement-to" label="Até"><Input id="statement-to" type="date" value={period.to} onChange={(event) => setPeriod({ ...period, to: event.target.value })} /></Field>
        </div>
        <a className="g-button g-button--secondary" href={`/api/v1/admin/finance/statement?${new URLSearchParams({ ...period, format: "csv" })}`} download><Download className="size-4" />Exportar CSV</a>
      </div>
      {statement && <dl aria-label="Resumo do extrato" className="mt-5 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div><dt className="text-[var(--g-text-muted)]">Entradas</dt><dd className="g-money text-lg font-bold">{formatMoney(statement.totals.inflowCents)}</dd></div>
        <div><dt className="text-[var(--g-text-muted)]">Saídas</dt><dd className="g-money text-lg font-bold">{formatMoney(statement.totals.outflowCents)}</dd></div>
        <div><dt className="text-[var(--g-text-muted)]">Resultado</dt><dd className="g-money text-lg font-bold">{formatMoney(statement.totals.inflowCents - statement.totals.outflowCents)}</dd></div>
      </dl>}
    </Card>
    {error && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 p-4 text-sm"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--g-status-danger)]" /><p>{error}</p></div>}
    {loading && !statement ? <p role="status" className="flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Carregando extrato…</p>
      : statement && <>
        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="p-5"><h2 className="font-semibold">Movimento por conta</h2><p className="mt-1 text-xs text-[var(--g-text-muted)]">Transferências e liquidações movem dinheiro entre contas sem virar receita. O saldo de cada conta fica em Saldo e conferência.</p>
            <ul aria-label="Movimento por conta" className="mt-3 space-y-2 text-sm">{financeAccountSchema.options.map((account) => <li key={account} className="flex justify-between gap-3"><span>{financeAccountLabels[account]}</span><span className="g-money font-semibold">{formatMoney(statement.totals.byAccount[account] ?? 0)}</span></li>)}</ul></Card>
          <Card className="p-5"><h2 className="font-semibold">Resultado por categoria</h2>
            {categories.length === 0 ? <p className="mt-3 text-sm text-[var(--g-text-secondary)]">Sem movimento no período.</p>
              : <ul aria-label="Resultado por categoria" className="mt-3 space-y-2 text-sm">{categories.map(([category, total]) => <li key={category} className="flex justify-between gap-3"><span>{financeCategoryLabels[category as keyof typeof financeCategoryLabels] ?? category}</span><span className="g-money font-semibold">{formatMoney(total)}</span></li>)}</ul>}</Card>
        </div>
        <Card className="overflow-hidden">
          {statement.data.length === 0 ? <p className="p-5 text-sm text-[var(--g-text-secondary)]">Nenhum movimento no período.</p>
            : <div className="overflow-x-auto"><table className="w-full min-w-[48rem] text-left text-sm">
              <caption className="sr-only">Movimentos do extrato</caption>
              <thead className="border-b border-[var(--g-border-subtle)] text-[var(--g-text-muted)]"><tr><th scope="col" className="p-3">Data</th><th scope="col" className="p-3">Tipo</th><th scope="col" className="p-3">Origem</th><th scope="col" className="p-3">Categoria</th><th scope="col" className="p-3">Conta</th><th scope="col" className="p-3">Descrição</th><th scope="col" className="p-3 text-right">Valor</th></tr></thead>
              <tbody className="divide-y divide-[var(--g-border-subtle)]">{statement.data.map((row) => <tr key={`${row.source}-${row.sourceId}-${row.account}`}>
                <td className="p-3 whitespace-nowrap">{formatDay(row.occurredOn)}</td><td className="p-3"><Badge tone={natureLabels[row.nature].tone}>{natureLabels[row.nature].label}</Badge></td><td className="p-3">{sourceLabels[row.source] ?? row.source}</td>
                <td className="p-3">{row.category ? financeCategoryLabels[row.category] : row.nature === "SALDO_ABERTURA" ? "Saldo de abertura" : "Transferência"}</td><td className="p-3">{financeAccountLabels[row.account]}</td>
                <td className="p-3">{row.description}{row.reference ? <span className="block text-xs text-[var(--g-text-muted)]">{row.reference}</span> : null}</td>
                <td className="g-money p-3 text-right font-semibold">{formatMoney(row.amountCents)}</td></tr>)}</tbody>
            </table></div>}
        </Card>
      </>}
  </div>;
}
