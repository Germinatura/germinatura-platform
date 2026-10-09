import Link from "next/link";
import { Badge, Card } from "@germinatura/ui";
import { picpayEvidenceOverviewSchema, type CohortSummary, type ManagementIndicators, type PicpayEvidenceOverview } from "@germinatura/contracts";
import { z } from "zod";
import { PicpayEvidenceSummary } from "@/components/admin/PicpayEvidenceSummary";
import { toCohortOverview } from "@/lib/cohort-admin";
import { currentMonthToDate, loadManagementIndicators } from "@/lib/management-indicators";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const formatMoney = (cents: number) => money.format(cents / 100);
const statusLabels = { PREPARING: "Em preparação", ACTIVE: "Ativa", ARCHIVED: "Arquivada" } as const;

const storedEvidenceSchema = z.object({
  imports: z.number().int(), last_period_to: z.string().nullable(), inflow_cents: z.number().int(), outflow_cents: z.number().int(),
  lines: z.number().int(), lines_pending: z.number().int(), lines_global: z.number().int(),
  lines_by_cohort: z.array(z.object({ cohort_id: z.uuid(), lines: z.number().int() })),
});

async function picpayEvidence(): Promise<PicpayEvidenceOverview | null> {
  const { data, error } = await (await createSupabaseServerClient()).rpc("picpay_evidence_overview");
  const stored = error ? null : storedEvidenceSchema.safeParse(data);
  if (!stored?.success) return null;
  return picpayEvidenceOverviewSchema.parse({
    imports: stored.data.imports, lastPeriodTo: stored.data.last_period_to, inflowCents: stored.data.inflow_cents, outflowCents: stored.data.outflow_cents,
    lines: stored.data.lines, linesPending: stored.data.lines_pending, linesGlobal: stored.data.lines_global,
    linesByCohort: stored.data.lines_by_cohort.map((item) => ({ cohortId: item.cohort_id, lines: item.lines })),
  });
}

/**
 * ADR 0011 (PR 4): the home of ADMIN_MASTER in "Todas as turmas". Each cohort is computed inside that cohort and shown
 * side by side; nothing here adds cohorts together, and the shared PicPay account appears apart as global evidence.
 * Acting on any of it needs a concrete cohort, chosen in the selector.
 */
export async function ConsolidatedOverview({ name, cohorts }: { name: string; cohorts: CohortSummary[] }) {
  const month = currentMonthToDate();
  const client = await createSupabaseServerClient();
  const [overview, evidence, figures] = await Promise.all([
    client.rpc("cohort_overview").then(({ data, error }) => (error ? [] : toCohortOverview(data)), () => []),
    picpayEvidence().catch(() => null),
    Promise.all(cohorts.map(async (cohort): Promise<[string, ManagementIndicators | null]> => {
      const cohortClient = await createSupabaseServerClient(cohort.id);
      return [cohort.id, await loadManagementIndicators(cohortClient, month.from, month.to).catch(() => null)];
    })),
  ]);
  const indicators = new Map(figures);
  const members = new Map(overview.map((item) => [item.id, item]));
  const names = Object.fromEntries(cohorts.map((cohort) => [cohort.id, cohort.name]));

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <div className="mx-auto max-w-[var(--g-content-standard)] space-y-8">
        <header>
          <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Todas as turmas</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Olá, {name}</h1>
          <p className="mt-2 max-w-2xl text-base text-[var(--g-text-secondary)]">Comparação das turmas no mês, cada uma pelo próprio livro. Para criar ou alterar dados, escolha uma turma no seletor acima.</p>
        </header>
        <section aria-label="Comparação das turmas" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {cohorts.map((cohort) => {
            const value = indicators.get(cohort.id);
            const counts = members.get(cohort.id);
            const pending = value ? Object.values(value.pending).reduce((total, item) => total + item, 0) - value.pending.statementLinesPending : null;
            return <Card key={cohort.id} className="p-5" aria-label={cohort.name}>
              <div className="flex items-center justify-between gap-2"><h2 className="text-lg font-bold">{cohort.name}</h2><Badge tone={cohort.status === "ACTIVE" ? "success" : cohort.status === "ARCHIVED" ? "warning" : "info"}>{statusLabels[cohort.status]}</Badge></div>
              <p className="mt-1 text-xs text-[var(--g-text-muted)]">Livro da turma · {counts ? `${counts.membersActive} vínculos ativos` : "vínculos indisponíveis"}</p>
              {!value ? <p className="mt-4 text-sm">Indicadores indisponíveis para esta turma.</p> : <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div><dt className="text-[var(--g-text-muted)]">Vendas no mês</dt><dd className="font-semibold">{value.totals.salesCount}</dd></div>
                <div><dt className="text-[var(--g-text-muted)]">Receita líquida</dt><dd className="font-semibold">{formatMoney(value.totals.netRevenueCents)}</dd></div>
                <div><dt className="text-[var(--g-text-muted)]">Lucro operacional</dt><dd className="font-semibold">{formatMoney(value.totals.operatingProfitCents)}</dd></div>
                <div><dt className="text-[var(--g-text-muted)]">Pendências da turma</dt><dd className="font-semibold">{pending}</dd></div>
              </dl>}
            </Card>;
          })}
        </section>
        <PicpayEvidenceSummary evidence={evidence} cohortNames={names} />
        <p className="text-sm text-[var(--g-text-secondary)]">Detalhes: <Link className="font-semibold underline" href="/admin/financeiro/indicadores">indicadores lado a lado</Link>, <Link className="font-semibold underline" href="/admin/financeiro/vendas">vendas com a turma de cada uma</Link>, <Link className="font-semibold underline" href="/admin/usuarios">usuários e vínculos</Link> e <Link className="font-semibold underline" href="/admin/turmas">turmas</Link>.</p>
      </div>
    </div>
  );
}
