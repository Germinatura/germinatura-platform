"use client";

import { financeBalancesResponseSchema, type FinanceBalances } from "@germinatura/contracts";
import { Card } from "@germinatura/ui";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { financeAccountLabels } from "@/lib/finance-labels";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const formatMoney = (cents: number) => money.format(cents / 100);
const formatDay = (value: string) => value.split("-").reverse().join("/");

/**
 * Spec 5.8 (FIN-002): treasury balances from the single database authority. The financial balance is free (PicPay
 * Empresas) plus Cofrinho; receivables and physical cash are shown apart and never added to it. It is not profit.
 */
export function FinanceBalancesSummary({ refreshKey = 0, onLoaded }: { refreshKey?: number; onLoaded?: (balances: FinanceBalances) => void }) {
  const [balances, setBalances] = useState<FinanceBalances | null>(null);
  const [error, setError] = useState("");
  // The callback may change on every render of the parent; keeping it in a ref avoids reloading in a loop.
  const loaded = useRef(onLoaded);
  useEffect(() => { loaded.current = onLoaded; }, [onLoaded]);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/admin/finance/balances", { cache: "no-store" });
      if (!response.ok) throw new Error("Não foi possível consultar os saldos agora.");
      const parsed = financeBalancesResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("A consulta de saldos retornou dados inválidos.");
      setBalances(parsed.data.data); setError("");
      loaded.current?.(parsed.data.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível consultar os saldos agora."); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load, refreshKey]);

  if (error) return <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 p-4 text-sm"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--g-status-danger)]" /><p>{error}</p></div>;
  if (!balances) return <p role="status" className="flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Carregando saldos…</p>;
  const pending = balances.statementLines.pending;
  return <div className="grid gap-4">
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr_1fr]">
      <Card className="p-5">
        <section aria-label="Saldo financeiro">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--g-text-muted)]">Saldo financeiro</h2>
          <dl className="mt-3 grid gap-4 sm:grid-cols-3">
            <div><dt className="text-sm text-[var(--g-text-secondary)]">Saldo livre</dt><dd className="g-money mt-1 text-2xl font-bold">{formatMoney(balances.freeBalanceCents)}</dd></div>
            <div><dt className="text-sm text-[var(--g-text-secondary)]">Cofrinho</dt><dd className="g-money mt-1 text-2xl font-bold">{formatMoney(balances.vaultBalanceCents)}</dd></div>
            <div><dt className="text-sm text-[var(--g-text-secondary)]">Saldo financeiro total</dt><dd className="g-money mt-1 text-2xl font-bold text-[var(--g-brand-primary)]">{formatMoney(balances.availableBalanceCents)}</dd></div>
          </dl>
          <p className="mt-3 text-xs text-[var(--g-text-muted)]">Saldo livre do PicPay Empresas mais o Cofrinho em {formatDay(balances.asOf)}. Não é lucro: lucro é o resultado do período, em Indicadores.</p>
        </section>
      </Card>
      <Card className="p-5">
        <section aria-label="A receber">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--g-text-muted)]">A receber</h2>
          <p className="mt-3 text-sm text-[var(--g-text-secondary)]">Recebíveis PicPay</p>
          <p className="g-money mt-1 text-2xl font-bold">{formatMoney(balances.receivablesBalanceCents)}</p>
          <p className="mt-3 text-xs text-[var(--g-text-muted)]">Cartão ainda não liquidado; fora do saldo financeiro.</p>
        </section>
      </Card>
      <Card className="p-5">
        <section aria-label="Dinheiro físico">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--g-text-muted)]">Dinheiro físico</h2>
          <p className="mt-3 text-sm text-[var(--g-text-secondary)]">Caixa</p>
          <p className="g-money mt-1 text-2xl font-bold">{formatMoney(balances.cashBalanceCents)}</p>
          <p className="mt-3 text-xs text-[var(--g-text-muted)]">Dinheiro em espécie; fora do saldo financeiro.</p>
        </section>
      </Card>
    </div>
    {balances.negativeAccounts.length > 0 && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 p-4 text-sm"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--g-status-danger)]" /><p>Saldo negativo em {balances.negativeAccounts.map((account) => financeAccountLabels[account]).join(", ")}. Um saldo negativo é impossível: confira as linhas do extrato e os lançamentos dessas contas.</p></div>}
    {balances.opening === null && <p role="note" className="text-sm text-[var(--g-text-secondary)]">A posição de abertura ainda não foi registrada; os saldos somam só os movimentos desde o início do sistema.</p>}
    {pending.count > 0 && <p role="note" className="text-sm text-[var(--g-status-warning-foreground)]">{pending.count} linha(s) do extrato PicPay aguardam revisão ({formatMoney(pending.netCents)} líquidos) e ainda não entram no saldo.</p>}
  </div>;
}
