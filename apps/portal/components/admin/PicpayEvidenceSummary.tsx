import { Card } from "@germinatura/ui";
import { Landmark } from "lucide-react";
import type { PicpayEvidenceOverview } from "@germinatura/contracts";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const formatDay = (value: string) => value.slice(0, 10).split("-").reverse().join("/");

/**
 * ADR 0011 (PR 4): the PicPay Empresas account is one account shared by every cohort. Its statement is global
 * evidence; this panel shows it as such and never derives a balance per cohort from it.
 */
export function PicpayEvidenceSummary({ evidence, cohortNames }: { evidence: PicpayEvidenceOverview | null; cohortNames: Record<string, string> }) {
  return (
    <Card className="p-5">
      <div className="flex items-start gap-3"><Landmark className="mt-0.5 size-5 text-[var(--g-text-muted)]" /><div>
        <h2 className="text-lg font-bold">Conta PicPay Empresas: evidência global</h2>
        <p className="mt-1 text-sm text-[var(--g-text-secondary)]">Uma conta só, compartilhada por todas as turmas. O extrato não é dividido em saldos por turma; cada linha é atribuída ao livro de uma turma na conciliação.</p>
      </div></div>
      {!evidence ? <p className="mt-4 text-sm">Evidência indisponível no momento.</p> : (
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-[var(--g-text-muted)]">Extratos importados</dt><dd className="font-semibold">{evidence.imports}{evidence.lastPeriodTo ? ` · até ${formatDay(evidence.lastPeriodTo)}` : ""}</dd></div>
          <div><dt className="text-[var(--g-text-muted)]">Entradas e saídas no extrato</dt><dd className="font-semibold">{money.format(evidence.inflowCents / 100)} · {money.format(evidence.outflowCents / 100)}</dd></div>
          <div><dt className="text-[var(--g-text-muted)]">Linhas do extrato</dt><dd className="font-semibold">{evidence.lines} ({evidence.linesPending} sem classificação)</dd></div>
          <div><dt className="text-[var(--g-text-muted)]">Classificadas como globais</dt><dd className="font-semibold">{evidence.linesGlobal}</dd></div>
          {evidence.linesByCohort.map((item) => <div key={item.cohortId}><dt className="text-[var(--g-text-muted)]">Atribuídas a {cohortNames[item.cohortId] ?? "turma"}</dt><dd className="font-semibold">{item.lines}</dd></div>)}
        </dl>
      )}
    </Card>
  );
}
