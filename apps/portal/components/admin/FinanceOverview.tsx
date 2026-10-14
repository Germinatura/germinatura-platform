"use client";

import { financeOverviewResponseSchema, type CutoverCounterpart, type FinanceOverview as Overview } from "@germinatura/contracts";
import { Badge, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const brl = (cents: number) => money.format(cents / 100);
const day = (value: string) => value.split("-").reverse().join("/");
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const shift = (value: string, days: number) => { const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
const accountLabels: Record<string, string> = {
  PICPAY_EMPRESAS: "PicPay saldo livre", COFRINHO_PICPAY: "Cofrinho PicPay", DINHEIRO_FISICO: "Dinheiro físico",
  RECEBIVEIS_PICPAY: "Recebíveis PicPay", PENDENTE_LIQUIDACAO: "Pix em trânsito",
};
const statusLabels: Record<string, { label: string; tone: "success" | "warning" | "danger" | "info" }> = {
  CONFIRMADA: { label: "Confirmada", tone: "success" }, ESTIMADA: { label: "Estimada", tone: "warning" }, NAO_DETERMINAVEL: { label: "Não determinável", tone: "danger" },
};
const componentLabels: Record<string, string> = {
  RECEITA: "Receita", REEMBOLSO: "Reembolsos", TAXA: "Taxas", CMV: "CMV", PERDA: "Perdas", DESPESA_OPERACIONAL: "Despesas operacionais",
};
const originLabels: Record<string, string> = {
  TRACEABILITY_BASELINE: "implantação (estoque inicial sem custo)", STOCK_MOVEMENT_ITEM: "entrada por ajuste, sem compra", PURCHASE_RECEIPT: "compra",
  DESCONHECIDA: "origem desconhecida",
};

function Row({ label, cents, note, strong, muted }: { label: string; cents: number; note?: string; strong?: boolean; muted?: boolean }) {
  return <div className={`flex flex-wrap items-baseline justify-between gap-x-4 border-t border-[var(--g-border-subtle)] py-2 ${muted ? "text-[var(--g-text-muted)]" : ""}`}>
    <dt className={strong ? "font-semibold" : ""}>{label}{note && <span className="block text-xs text-[var(--g-text-muted)]">{note}</span>}</dt>
    <dd className={`g-money ${strong ? "font-bold" : ""}`}>{brl(cents)}</dd>
  </div>;
}

/**
 * PR E: the financial overview. Each block keeps its meaning: real resources, future receivables and commitments, the
 * official result and its management presentation (never a different result), COGS visibility, the goal and the bridge.
 */
export function FinanceOverview() {
  const [period, setPeriod] = useState({ from: shift(today(), -29), to: today() });
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    const response = await fetch(`/api/v1/admin/finance/overview?${new URLSearchParams(period)}`, { cache: "no-store" });
    const body = await response.json().catch(() => null) as { message?: string } | null;
    if (!response.ok) { setError(body?.message ?? "Não foi possível carregar a visão financeira."); return; }
    const parsed = financeOverviewResponseSchema.safeParse(body);
    if (!parsed.success) { setError("A visão financeira retornou dados inválidos."); return; }
    setData(parsed.data.data);
  }, [period]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  const real = data ? data.position.freeCents + data.position.vaultCents + data.position.cashCents : 0;
  const presentation = data?.result.presentation;
  return <div className="grid gap-6">
    <Card className="p-5"><section aria-label="Período" className="flex flex-wrap items-end gap-4">
      <Field id="overview-from" label="De"><Input id="overview-from" type="date" value={period.from} onChange={(event) => setPeriod({ ...period, from: event.target.value })} /></Field>
      <Field id="overview-to" label="Até"><Input id="overview-to" type="date" value={period.to} onChange={(event) => setPeriod({ ...period, to: event.target.value })} /></Field>
      {data?.period.operatingSince && <p className="text-sm text-[var(--g-text-secondary)]">Operação no Germinatura desde {day(data.period.operatingSince)}; antes disso, histórico reconstruído.</p>}
    </section></Card>
    {error && <p role="alert" className="flex items-start gap-2 text-sm text-[var(--g-status-danger)]"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{error}</p>}
    {!data && !error && <p role="status" className="flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Carregando…</p>}
    {data && presentation && <>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5"><section aria-label="Posição financeira">
          <h2 className="font-semibold">Recursos reais em {day(data.period.asOf)}</h2>
          <dl className="mt-2">
            <Row label="PicPay saldo livre" cents={data.position.freeCents} />
            <Row label="Cofrinho PicPay" cents={data.position.vaultCents} />
            <Row label="Dinheiro físico" cents={data.position.cashCents} note="Em posse do caixa ou dos vendedores" />
            <Row label="Recursos acumulados" cents={real} strong />
            <Row label="Contas a pagar em aberto" cents={-data.payables.openCents} note={`${data.payables.openCount} conta(s)`} />
            <Row label="Disponível líquido" cents={real - data.payables.openCents} strong />
          </dl>
          <h3 className="mt-4 text-sm font-semibold">Valor futuro (fora da meta)</h3>
          <dl><Row label="Recebíveis PicPay" cents={data.position.receivablesCents} muted /><Row label="Pix em trânsito" cents={data.position.pixInTransitCents} muted /></dl>
        </section></Card>
        <Card className="p-5"><section aria-label="Resultado do período">
          <h2 className="font-semibold">Resultado de {day(data.period.from)} a {day(data.period.to)}</h2>
          <dl className="mt-2">
            <Row label="Receita operacional" cents={presentation.operatingRevenuePresentedCents} />
            <Row label="Ajustes técnicos de cutover" cents={presentation.technicalCutoverCounterpartsCents} muted
              note="Memória de reconciliação: contrapartidas fora da receita; não somam de novo no resultado." />
            <Row label="Deduções (reembolsos e taxas)" cents={-presentation.deductionsCents} />
            <Row label="Despesas operacionais registradas" cents={-presentation.operatingExpensesRegisteredCents} />
            <Row label="Contrapartidas técnicas" cents={presentation.counterpartsCents} />
            <Row label="Despesa operacional apresentada" cents={-presentation.operatingExpensesPresentedCents} />
            <Row label="CMV" cents={-presentation.cogsCents} note={data.result.historicalAdjustments.CMV ? "Inclui CMV histórico sem caixa" : undefined} />
            <Row label="Perdas" cents={-presentation.lossesCents} />
            <Row label="Resultado operacional" cents={data.result.officialCents} strong />
          </dl>
          {presentation.operatingResultCents !== data.result.officialCents && <p role="alert" className="mt-2 text-sm text-[var(--g-status-danger)]">A apresentação diverge do resultado oficial: revise antes de usar.</p>}
          {presentation.counterpartsOutsideWindow > 0 && <p role="status" className="mt-2 text-sm text-[var(--g-status-warning-foreground)]">Existe contrapartida técnica vinculada fora do período consultado.</p>}
          {presentation.invalidDesignations > 0 && <p role="status" className="mt-2 text-sm text-[var(--g-status-warning-foreground)]">{presentation.invalidDesignations} designação(ões) inválida(s): a despesa ou a contrapartida mudou. Revise em Ajustes históricos.</p>}
          <dl className="mt-3 text-sm">
            <Row label="Ajustes históricos sem caixa (efeito no resultado)" cents={data.result.historicalAdjustmentsCents}
              note={Object.entries(data.result.historicalAdjustments).map(([component, effect]) => `${componentLabels[component] ?? component}: ${brl(effect.resultEffectCents)}`).join(" · ") || "Nenhum no período"} />
            {data.result.historicalCents !== null && <Row label="Resultado histórico (antes da operação)" cents={data.result.historicalCents} />}
            {data.result.nativeCents !== null && <Row label="Resultado da operação no Germinatura" cents={data.result.nativeCents} />}
          </dl>
        </section></Card>
      </div>

      {data.counterparts.length > 0 && <Card className="p-5"><section aria-label="Contrapartidas técnicas do período">
        <h2 className="font-semibold">Contrapartidas técnicas de cutover</h2>
        <p className="mt-1 text-sm text-[var(--g-text-secondary)]">Classificação gerencial; lançamentos originais preservados.</p>
        <ul className="mt-3 grid gap-3">{data.counterparts.map((item) => <CounterpartDetail key={item.id} item={item} />)}</ul>
      </section></Card>}

      <Card className="p-5"><section aria-label="Custo das mercadorias vendidas">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">CMV: o que se sabe do custo</h2>
          <Badge tone={data.result.costVisibility.status === "COMPLETO" ? "success" : data.result.costVisibility.status === "ESTIMADO" ? "warning" : "danger"}>
            {data.result.costVisibility.status === "COMPLETO" ? "Completo" : data.result.costVisibility.status === "ESTIMADO" ? "Estimável" : "Incompleto"}</Badge>
        </div>
        <dl className="mt-2 grid gap-x-6 text-sm sm:grid-cols-2">
          <div className="flex justify-between border-t border-[var(--g-border-subtle)] py-2"><dt>Unidades com custo conhecido</dt><dd>{data.result.costVisibility.unitsKnownPositive}</dd></div>
          <div className="flex justify-between border-t border-[var(--g-border-subtle)] py-2"><dt>Unidades com custo zero legítimo</dt><dd>{data.result.costVisibility.unitsKnownZero}</dd></div>
          <div className="flex justify-between border-t border-[var(--g-border-subtle)] py-2"><dt>Unidades com custo desconhecido</dt><dd>{data.result.costVisibility.unitsUnknown}</dd></div>
          <div className="flex justify-between border-t border-[var(--g-border-subtle)] py-2"><dt>Vendas afetadas</dt><dd>{data.result.costVisibility.salesWithUnknownCost}</dd></div>
          <div className="flex justify-between border-t border-[var(--g-border-subtle)] py-2"><dt>Estimáveis pelo custo médio de compra</dt><dd>{data.result.costVisibility.unitsEstimable}</dd></div>
          <div className="flex justify-between border-t border-[var(--g-border-subtle)] py-2"><dt>Sem base para estimar</dt><dd>{data.result.costVisibility.unitsNotEstimable}</dd></div>
        </dl>
        {data.result.costVisibility.unitsUnknown > 0 && <p className="mt-2 text-sm">
          Origem do estoque sem custo: {Object.entries(data.result.costVisibility.unknownByOrigin).map(([origin, units]) => `${originLabels[origin] ?? origin} (${units})`).join(", ")}.
          {" "}Estimativa analítica: <span className="g-money">{brl(data.result.costVisibility.estimatedUnknownCostCents)}</span> <Badge tone="warning">Estimada</Badge> — fora do resultado oficial; nenhum custo é gravado.
        </p>}
      </section></Card>

      <Card className="p-5"><section aria-label="Ponte resultado e caixa">
        <h2 className="font-semibold">Ponte resultado → posição financeira</h2>
        <p className="mt-1 text-sm text-[var(--g-text-secondary)]">Uma identidade sobre os mesmos livros: cada linha vem dos registros, e o resíduo é conferido, nunca ajustado.</p>
        <BridgeTable title={`Desde a abertura (${day(data.bridge.partA.from)} a ${day(data.bridge.partA.to)})`} lines={data.bridge.partA.lines}
          totals={[["= Posição real calculada (livre + Cofrinho + dinheiro físico)", data.bridge.partA.calculatedCents], ["Posição real pelos saldos", data.bridge.partA.positionCents],
            ["Resíduo", data.bridge.partA.residualCents]]} />
        {data.bridge.partB && <>
          <BridgeTable title={`Antes da abertura (${day(data.bridge.partB.from)} a ${day(data.bridge.partB.to)}), versão ${data.bridge.partB.declaredVersion}${data.bridge.partB.baseVersion ? ` a partir da versão ${data.bridge.partB.baseVersion}` : ""}`}
            lines={data.bridge.partB.lines} totals={[["= Ativos declarados na abertura", data.bridge.partB.declaredCents], ["Reconstruído pelos livros", data.bridge.partB.reconstructedCents]]} />
          {data.bridge.partB.accounts && <div role="region" aria-label="Diferença de cutover por conta" tabIndex={0} className="mt-3 overflow-x-auto"><table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="text-[var(--g-text-muted)]"><tr><th className="py-1 pr-3 font-medium">Conta</th><th className="py-1 pr-3 font-medium">Base</th><th className="py-1 pr-3 font-medium">Movimentos</th><th className="py-1 pr-3 font-medium">Reconstruído</th><th className="py-1 pr-3 font-medium">Declarado</th><th className="py-1 font-medium">Diferença</th></tr></thead>
            <tbody>{data.bridge.partB.accounts.map((account) => <tr key={account.account} className="border-t border-[var(--g-border-subtle)]">
              <td className="py-2 pr-3">{accountLabels[account.account] ?? account.account}</td><td className="g-money py-2 pr-3">{brl(account.baseCents)}</td>
              <td className="g-money py-2 pr-3">{brl(account.movementsCents)}</td><td className="g-money py-2 pr-3">{brl(account.reconstructedCents)}</td>
              <td className="g-money py-2 pr-3">{brl(account.declaredCents)}</td><td className="g-money py-2">{brl(account.differenceCents)}</td></tr>)}</tbody>
          </table></div>}
          {data.bridge.partB.counterparts.length > 0 && <ul className="mt-3 grid gap-1 text-sm">{data.bridge.partB.counterparts.map((item) =>
            <li key={item.id}>Contrapartida {item.counterpartReference ?? "sem referência"} ({brl(item.counterpartCents)}) neutraliza {brl(item.neutralizedCents)} de {item.targetReference ?? "despesa"} ({brl(item.targetCents)}): {item.reason}</li>)}</ul>}
        </>}
      </section></Card>
    </>}
  </div>;
}

function BridgeTable({ title, lines, totals }: { title: string; lines: Overview["bridge"]["partA"]["lines"]; totals: Array<[string, number]> }) {
  return <div className="mt-4">
    <h3 className="text-sm font-semibold">{title}</h3>
    <div role="region" aria-label={title} tabIndex={0} className="overflow-x-auto"><table className="w-full min-w-[36rem] text-left text-sm">
      <tbody>
        {lines.map((line) => <tr key={line.key} className="border-t border-[var(--g-border-subtle)]">
          <td className="py-2 pr-3">{line.label}</td><td className="g-money py-2 pr-3 text-right">{brl(line.cents)}</td>
          <td className="py-2"><Badge tone={statusLabels[line.status].tone}>{statusLabels[line.status].label}</Badge>
            {line.nature && <Badge tone={statusLabels[line.nature].tone} className="ml-1">Natureza: {statusLabels[line.nature].label.toLowerCase()}</Badge>}</td>
        </tr>)}
        {totals.map(([label, cents]) => <tr key={label} className="border-t border-[var(--g-border-default)] font-semibold">
          <td className="py-2 pr-3">{label}</td><td className="g-money py-2 pr-3 text-right">{brl(cents)}</td><td />
        </tr>)}
      </tbody>
    </table></div>
  </div>;
}

function CounterpartDetail({ item }: { item: CutoverCounterpart }) {
  return <li className="rounded-[var(--g-radius-card)] border border-[var(--g-border-subtle)] p-4 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone={item.status === "ATIVA" ? "success" : item.status === "INVALIDA" ? "warning" : "neutral"}>{item.status === "ATIVA" ? "Ativa" : item.status === "INVALIDA" ? "Inválida — revisar" : "Revogada"}</Badge>
      {item.inWindow === false && <span className="text-[var(--g-status-warning-foreground)]">Existe contrapartida técnica vinculada fora do período consultado.</span>}
    </div>
    <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
      <div><dt className="text-[var(--g-text-muted)]">Despesa original</dt><dd>{day(item.target.occurredOn)} · <span className="g-money">{brl(item.target.amountCents)}</span> · {item.target.description} · {item.target.reference ?? "sem referência"}</dd></div>
      <div><dt className="text-[var(--g-text-muted)]">Contrapartida</dt><dd>{day(item.counterpart.occurredOn)} · <span className="g-money">{brl(item.counterpart.amountCents)}</span> · {item.counterpart.description} · {item.counterpart.reference ?? "sem referência"}</dd></div>
      <div><dt className="text-[var(--g-text-muted)]">Valor neutralizado</dt><dd className="g-money">{brl(item.neutralizedCents)}</dd></div>
      <div><dt className="text-[var(--g-text-muted)]">Justificativa</dt><dd>{item.reason}</dd></div>
      <div><dt className="text-[var(--g-text-muted)]">Efeito no caixa</dt><dd className="g-money">{brl(item.cashEffectCents)}</dd></div>
      <div><dt className="text-[var(--g-text-muted)]">Efeito no resultado</dt><dd className="g-money">{brl(item.resultEffectCents)}</dd></div>
    </dl>
    <p className="mt-2 text-xs text-[var(--g-text-muted)]">classificação gerencial; lançamentos originais preservados</p>
  </li>;
}
