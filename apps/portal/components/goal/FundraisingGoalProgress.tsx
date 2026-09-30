import type { FundraisingGoal } from "@germinatura/contracts";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const date = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeZone: "UTC" });
const percent = (bps: number) => `${(bps / 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;

/** ADMIN-002: progress of the fundraising goal (operating profit); amounts only when the goal allows them. */
export function FundraisingGoalProgress({ goal, title = "Meta da formatura" }: { goal: FundraisingGoal; title?: string }) {
  const width = Math.min(goal.progressBps / 100, 100);
  const projected = Math.min(goal.projectedBps / 100, 100);
  return <div>
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-lg font-bold text-[var(--g-text-primary)]">{title}</h2>
      <p className="text-2xl font-bold text-[var(--g-brand-primary)]">{percent(goal.progressBps)}</p>
    </div>
    <div role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(width)} aria-valuetext={`${percent(goal.progressBps)} da meta`}
      className="relative mt-3 h-3 overflow-hidden rounded-full bg-[var(--g-surface-subtle)]">
      <div aria-hidden className="absolute inset-y-0 left-0 bg-[var(--g-brand-primary-soft)]" style={{ width: `${projected}%` }} />
      <div aria-hidden className="absolute inset-y-0 left-0 rounded-full bg-[var(--g-brand-primary)]" style={{ width: `${width}%` }} />
    </div>
    <p className="mt-3 text-sm text-[var(--g-text-secondary)]">
      {goal.currentCents !== null && goal.targetCents !== null ? <><strong className="g-money">{money.format(goal.currentCents / 100)}</strong> de <span className="g-money">{money.format(goal.targetCents / 100)}</span> · </> : null}
      {goal.daysRemaining > 0 ? `${goal.daysRemaining} dia(s) até ${date.format(new Date(`${goal.targetDate}T00:00:00Z`))}` : `Data-alvo: ${date.format(new Date(`${goal.targetDate}T00:00:00Z`))}`}
    </p>
    <p className="mt-1 text-sm">
      {goal.daysRemaining > 0
        ? <>No ritmo atual, a projeção é de <strong>{percent(goal.projectedBps)}</strong>{goal.projectedCents !== null ? <> (<span className="g-money">{money.format(goal.projectedCents / 100)}</span>)</> : null} na data-alvo{goal.onTrack ? " — meta ao alcance." : "."}</>
        : goal.onTrack ? "Meta alcançada." : "O prazo da meta terminou."}
    </p>
    <p className="mt-2 text-xs text-[var(--g-text-muted)]">Conta o lucro das vendas, rifas e eventos depois de custos, perdas e despesas.</p>
  </div>;
}
