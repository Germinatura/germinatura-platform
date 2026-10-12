"use client";

import type { PaymentSurchargeRuleView } from "@germinatura/contracts";
import { Button, Field } from "@germinatura/ui";
import { BadgePercent, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { formatMoney, loadSurchargeRules, surchargeFor, type SurchargeChoice } from "@/lib/operations";
import { surchargeRuleLabel } from "@/lib/operations-pure";

type Channel = "DINHEIRO" | "PIX_AREA" | "MAQUININHA" | "PAYMENT_LINK";

/**
 * PR D: the acréscimo of the chosen method over the sale total. Returns the amount to charge and the choice sent with
 * the confirmation (the server recomputes the acréscimo and refuses a different value).
 */
export function useSurcharge(channel: Channel, cardMethod: string | null, baseCents: number) {
  const [rules, setRules] = useState<PaymentSurchargeRuleView[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [waiving, setWaiving] = useState(false);
  const [waiverReason, setWaiverReason] = useState("");
  const reload = useCallback(async () => {
    try { setRules(await loadSurchargeRules()); setLoadError(false); } catch { setLoadError(true); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void reload(), 0); return () => window.clearTimeout(timer); }, [reload]);
  const computed = surchargeFor(rules, channel, cardMethod, baseCents);
  const active = computed.cents > 0;
  const waived = active && waiving;
  const chargeCents = baseCents + (waived ? 0 : computed.cents);
  const choice: SurchargeChoice = { surchargeCents: computed.cents, waiverReason: waived ? waiverReason.trim() : null };
  const reset = useCallback(() => { setWaiving(false); setWaiverReason(""); }, []);
  // Without the rules the total cannot be shown honestly, so charging waits for them.
  const ready = !loadError && (!waived || waiverReason.trim().length >= 5);
  return { rules, computed, active, waived, chargeCents, choice, ready, loadError, reload, reset, waiving, setWaiving, waiverReason, setWaiverReason };
}

export type SurchargeState = ReturnType<typeof useSurcharge>;

export function SurchargePanel({ state, baseCents, canWaive }: { state: SurchargeState; baseCents: number; canWaive: boolean }) {
  if (state.loadError) {
    return <div role="alert" className="mt-5 rounded-[var(--g-radius-control)] border border-[var(--g-status-danger)]/50 p-4 text-sm">
      Não foi possível carregar o acréscimo deste meio de pagamento. <button type="button" className="font-semibold underline" onClick={() => void state.reload()}>Tentar novamente</button>
    </div>;
  }
  if (!state.active || !state.computed.rule) return null;
  return <div className="mt-5 rounded-[var(--g-radius-control)] border border-[var(--g-border-default)] bg-[var(--g-surface-subtle)] p-4 text-sm" aria-label="Acréscimo do meio de pagamento">
    <div className="flex justify-between gap-3 text-[var(--g-text-secondary)]"><span>Produtos</span><span className="g-money">{formatMoney(baseCents)}</span></div>
    <div className={`mt-1 flex justify-between gap-3 ${state.waived ? "text-[var(--g-text-muted)] line-through" : ""}`}>
      <span className="flex items-center gap-1.5"><BadgePercent className="size-4" /> Acréscimo do meio de pagamento ({surchargeRuleLabel(state.computed.rule)})</span>
      <span className="g-money">+ {formatMoney(state.computed.cents)}</span>
    </div>
    <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-[var(--g-border-default)] pt-2"><strong>Total a cobrar</strong><strong className="g-money text-lg">{formatMoney(state.chargeCents)}</strong></div>
    <p className="mt-2 text-xs text-[var(--g-text-muted)]">Informe o cliente antes de cobrar. O acréscimo é cobrado do cliente e não é a tarifa do PicPay.</p>
    {canWaive && (state.waiving
      ? <div className="mt-3 grid gap-2">
        <Field id="surcharge-waiver-reason" label="Motivo da remoção do acréscimo" description="Fica registrado com o seu nome, o valor dispensado e a regra em vigor.">
          <textarea id="surcharge-waiver-reason" value={state.waiverReason} onChange={(event) => state.setWaiverReason(event.target.value)} maxLength={500} rows={2} className="g-input w-full p-3" />
        </Field>
        <Button variant="ghost" size="sm" onClick={state.reset}><X className="size-4" /> Manter o acréscimo</Button>
      </div>
      : <Button variant="secondary" size="sm" className="mt-3" onClick={() => state.setWaiving(true)}>Remover acréscimo</Button>)}
  </div>;
}
