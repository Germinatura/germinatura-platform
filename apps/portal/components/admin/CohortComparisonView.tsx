"use client";

import { consolidatedIndicatorsResponseSchema, picpayEvidenceOverviewSchema, type ConsolidatedIndicators, type ManagementIndicators, type PicpayEvidenceOverview } from "@germinatura/contracts";
import { Button, Card, Field, Input } from "@germinatura/ui";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PicpayEvidenceSummary } from "@/components/admin/PicpayEvidenceSummary";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const formatMoney = (cents: number) => money.format(cents / 100);
const percent = (bps: number | null) => bps === null ? "—" : `${(bps / 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date()); }

type Totals = ManagementIndicators["totals"];
// Book figures of each cohort. "sum" marks the ones whose total across cohorts is meaningful (a sum of separate books).
const metrics: { label: string; value: (totals: Totals) => string; raw?: (totals: Totals) => number; sum: boolean; note?: string }[] = [
  { label: "Vendas confirmadas", value: (t) => String(t.salesCount), raw: (t) => t.salesCount, sum: true },
  { label: "Receita bruta", value: (t) => formatMoney(t.grossRevenueCents), raw: (t) => t.grossRevenueCents, sum: true },
  { label: "Estornos", value: (t) => formatMoney(t.refundsCents), raw: (t) => t.refundsCents, sum: true },
  { label: "Taxas", value: (t) => formatMoney(t.feesCents), raw: (t) => t.feesCents, sum: true },
  { label: "Receita líquida", value: (t) => formatMoney(t.netRevenueCents), raw: (t) => t.netRevenueCents, sum: true },
  { label: "Custo das vendas", value: (t) => formatMoney(t.cogsCents), raw: (t) => t.cogsCents, sum: true },
  { label: "Perdas (custo)", value: (t) => formatMoney(t.lossesCostCents), raw: (t) => t.lossesCostCents, sum: true },
  { label: "Despesas operacionais", value: (t) => formatMoney(t.operatingExpensesCents), raw: (t) => t.operatingExpensesCents, sum: true },
  { label: "Lucro operacional", value: (t) => formatMoney(t.operatingProfitCents), raw: (t) => t.operatingProfitCents, sum: true },
  { label: "Ticket médio", value: (t) => (t.averageTicketCents === null ? "—" : formatMoney(t.averageTicketCents)), sum: false },
  { label: "Margem bruta", value: (t) => percent(t.grossMarginBps), sum: false },
  { label: "Caixa do livro da turma", value: (t) => formatMoney(t.cashBalanceCents), sum: false, note: "Não é saldo bancário: a conta PicPay é global." },
];

/**
 * ADR 0011 (PR 4): indicators of each cohort side by side for ADMIN_MASTER in "Todas as turmas". Every column is one
 * cohort computed inside that cohort; the last column adds only the book figures whose sum means something, and the
 * shared PicPay account appears apart as global evidence.
 */
export function CohortComparisonView() {
  const [range, setRange] = useState(() => ({ from: `${today().slice(0, 8)}01`, to: today() }));
  const [data, setData] = useState<ConsolidatedIndicators | null>(null);
  const [evidence, setEvidence] = useState<PicpayEvidenceOverview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [response, picpay] = await Promise.all([
        fetch(`/api/v1/admin/consolidated/indicators?${new URLSearchParams(range)}`, { cache: "no-store" }),
        fetch("/api/v1/admin/consolidated/picpay", { cache: "no-store" }),
      ]);
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error((body as { message?: string } | null)?.message ?? "Não foi possível comparar as turmas.");
      setData(consolidatedIndicatorsResponseSchema.parse(body).data);
      const picpayBody = picpay.ok ? await picpay.json() as { data?: unknown } : null;
      const parsedEvidence = picpayEvidenceOverviewSchema.safeParse(picpayBody?.data);
      setEvidence(parsedEvidence.success ? parsedEvidence.data : null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível comparar as turmas."); setData(null); }
    finally { setLoading(false); }
  }, [range]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 200); return () => window.clearTimeout(timer); }, [load]);

  const cohorts = data?.cohorts ?? [];
  const computed = cohorts.filter((cohort) => cohort.indicators !== null);
  return (
    <div className="space-y-6">
      <Card className="p-5">
        <p className="text-sm text-[var(--g-text-secondary)]">Visão de todas as turmas: cada coluna é o livro de uma turma. Para ver os detalhes ou agir, escolha uma turma no seletor acima.</p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Field id="comparison-from" label="De"><Input id="comparison-from" type="date" value={range.from} onChange={(event) => setRange({ ...range, from: event.target.value })} /></Field>
          <Field id="comparison-to" label="Até"><Input id="comparison-to" type="date" value={range.to} onChange={(event) => setRange({ ...range, to: event.target.value })} /></Field>
          <Button type="button" variant="secondary" onClick={() => void load()} loading={loading}><RefreshCw className="size-4" /> Atualizar</Button>
        </div>
      </Card>
      {error && <p role="alert" className="text-sm text-[var(--g-status-danger-foreground)]">{error}</p>}
      {data && <Card className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm" aria-label="Indicadores por turma">
          <thead className="bg-[var(--g-surface-subtle)] text-xs uppercase tracking-wide text-[var(--g-text-muted)]">
            <tr><th className="px-4 py-3">Indicador</th>{cohorts.map((cohort) => <th key={cohort.cohortId} className="px-4 py-3">{cohort.name}{cohort.status === "ARCHIVED" ? " (arquivada)" : ""}</th>)}<th className="px-4 py-3">Soma dos livros</th></tr>
          </thead>
          <tbody className="divide-y divide-[var(--g-border-subtle)]">
            {metrics.map((metric) => <tr key={metric.label}>
              <th scope="row" className="px-4 py-3 font-semibold">{metric.label}{metric.note && <span className="block text-xs font-normal text-[var(--g-text-muted)]">{metric.note}</span>}</th>
              {cohorts.map((cohort) => <td key={cohort.cohortId} className="px-4 py-3">{cohort.indicators ? metric.value(cohort.indicators.totals) : "indisponível"}</td>)}
              <td className="px-4 py-3 font-semibold">{metric.sum && metric.raw && computed.length === cohorts.length
                ? (metric.label === "Vendas confirmadas" ? String(computed.reduce((total, cohort) => total + metric.raw!(cohort.indicators!.totals), 0))
                  : formatMoney(computed.reduce((total, cohort) => total + metric.raw!(cohort.indicators!.totals), 0)))
                : "—"}</td>
            </tr>)}
          </tbody>
        </table>
        {computed.length !== cohorts.length && <p className="p-4 text-xs text-[var(--g-text-muted)]">Sem soma: os indicadores de alguma turma estão indisponíveis.</p>}
      </Card>}
      <PicpayEvidenceSummary evidence={evidence} cohortNames={Object.fromEntries(cohorts.map((cohort) => [cohort.cohortId, cohort.name]))} />
    </div>
  );
}
