"use client";

import {
  paymentSurchargeRulesResponseSchema, savePaymentSurchargeRuleRequestSchema, savePaymentSurchargeRuleResponseSchema,
  type PaymentSurchargeHistoryItem, type PaymentSurchargeMethodKey, type PaymentSurchargeMode, type PaymentSurchargeRuleView,
} from "@germinatura/contracts";
import { parseBrlToCents } from "@germinatura/domain";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";

const methodLabels: Record<PaymentSurchargeMethodKey, string> = { DINHEIRO: "Dinheiro", PIX: "Área Pix", CREDITO: "Crédito (maquininha)", DEBITO: "Débito (maquininha)" };
const modeLabels: Record<PaymentSurchargeMode, string> = { NONE: "Sem acréscimo", PERCENTAGE: "Percentual", FIXED: "Valor fixo" };
const money = (cents: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
const percent = (bps: number) => `${(bps / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });

function describe(rule: { mode: PaymentSurchargeMode; rateBps: number | null; fixedCents: number | null }) {
  if (rule.mode === "PERCENTAGE" && rule.rateBps !== null) return percent(rule.rateBps);
  if (rule.mode === "FIXED" && rule.fixedCents !== null) return money(rule.fixedCents);
  return "Sem acréscimo";
}

/** "3,49" → 349 basis points (two decimals at most), or null. */
function parsePercent(value: string): number | null {
  const match = value.trim().replace("%", "").trim().match(/^(\d{1,3})(?:[,.](\d{1,2}))?$/);
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bps >= 1 && bps <= 10_000 ? bps : null;
}

async function messageFrom(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? fallback;
}

/** PR D: finance sets, per cohort, the acréscimo of each PDV method; every change is a new audited version. */
export function PaymentSurchargesManagement() {
  const { showToast } = useToast();
  const [rules, setRules] = useState<PaymentSurchargeRuleView[]>([]);
  const [history, setHistory] = useState<PaymentSurchargeHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ method: PaymentSurchargeMethodKey; mode: PaymentSurchargeMode; value: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<PaymentSurchargeMethodKey | "ALL">("ALL");
  const keys = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/v1/admin/finance/surcharges", { cache: "no-store" });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível carregar os acréscimos."));
      const parsed = paymentSurchargeRulesResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("A consulta retornou dados inválidos.");
      setRules(parsed.data.data.rules); setHistory(parsed.data.data.history ?? []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar os acréscimos."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const amount = editing.mode === "PERCENTAGE" ? parsePercent(editing.value) : editing.mode === "FIXED" ? (() => {
      try { return parseBrlToCents(editing.value); } catch { return null; }
    })() : null;
    const payload = editing.mode === "NONE" ? { method: editing.method, mode: "NONE" as const, reason: editing.reason }
      : editing.mode === "PERCENTAGE" ? { method: editing.method, mode: "PERCENTAGE" as const, rateBps: amount, reason: editing.reason }
      : { method: editing.method, mode: "FIXED" as const, fixedCents: amount, reason: editing.reason };
    const parsed = savePaymentSurchargeRuleRequestSchema.safeParse(payload);
    if (!parsed.success) {
      setError(editing.mode === "PERCENTAGE" ? "Informe um percentual entre 0,01% e 100% e o motivo da mudança."
        : editing.mode === "FIXED" ? "Informe um valor fixo entre R$ 0,01 e R$ 10.000,00 e o motivo da mudança." : "Informe o motivo da mudança.");
      return;
    }
    const fingerprint = JSON.stringify(parsed.data);
    const key = keys.current.get(fingerprint) ?? `surcharge-rule:${crypto.randomUUID()}`;
    keys.current.set(fingerprint, key);
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/v1/admin/finance/surcharges", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(parsed.data),
      });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível salvar o acréscimo."));
      if (!savePaymentSurchargeRuleResponseSchema.safeParse(await response.json()).success) throw new Error("O acréscimo retornou dados inválidos.");
      showToast(`Acréscimo de ${methodLabels[editing.method]} atualizado.`, "success");
      setEditing(null);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar o acréscimo."); }
    finally { setBusy(false); }
  }

  const visibleHistory = history.filter((item) => historyFilter === "ALL" || item.method === historyFilter);
  return <div className="grid gap-6">
    {error && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 p-4 text-sm"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--g-status-danger)]" /><p>{error}</p></div>}
    <Card className="overflow-hidden">
      <div className="border-b border-[var(--g-border-subtle)] p-5"><h2 className="font-semibold">Regras em vigor</h2>
        <p className="mt-1 text-sm text-[var(--g-text-secondary)]">Percentual arredondado para baixo, em centavos, sobre o total da venda já com descontos; o valor fixo é cobrado uma vez por venda. V.A./V.R. seguem registrados como Crédito. O link de pagamento não recebe acréscimo.</p></div>
      {loading ? <p role="status" className="flex items-center gap-2 p-5 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Carregando acréscimos…</p>
        : <ul aria-label="Acréscimos por meio de pagamento" className="divide-y divide-[var(--g-border-subtle)]">
          {rules.map((rule) => <li key={rule.method} aria-label={`Acréscimo de ${methodLabels[rule.method]}`} className="p-5">
            {editing?.method === rule.method
              ? <form aria-label={`Alterar acréscimo de ${methodLabels[rule.method]}`} onSubmit={save} className="grid gap-4">
                <fieldset><legend className="text-sm font-semibold">{methodLabels[rule.method]}: modo</legend>
                  <div className="mt-2 flex flex-wrap gap-2">{(["NONE", "PERCENTAGE", "FIXED"] as const).map((mode) => <Button key={mode} type="button" size="sm" variant={editing.mode === mode ? "brand" : "secondary"} aria-pressed={editing.mode === mode} onClick={() => setEditing({ ...editing, mode, value: "" })}>{modeLabels[mode]}</Button>)}</div>
                </fieldset>
                {editing.mode !== "NONE" && <Field id={`surcharge-value-${rule.method}`} label={editing.mode === "PERCENTAGE" ? "Percentual (%)" : "Valor fixo (R$)"} description={editing.mode === "PERCENTAGE" ? "Ex.: 3,49" : "Ex.: 1,50"}>
                  <Input id={`surcharge-value-${rule.method}`} inputMode="decimal" required value={editing.value} onChange={(event) => setEditing({ ...editing, value: event.target.value })} autoComplete="off" />
                </Field>}
                <Field id={`surcharge-reason-${rule.method}`} label="Motivo da mudança" description="Fica no histórico e na auditoria.">
                  <Input id={`surcharge-reason-${rule.method}`} required minLength={3} maxLength={500} value={editing.reason} onChange={(event) => setEditing({ ...editing, reason: event.target.value })} />
                </Field>
                <div className="flex gap-2"><Button type="submit" loading={busy} disabled={busy}>Salvar nova versão</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>Cancelar</Button></div>
              </form>
              : <div className="flex flex-wrap items-center justify-between gap-3">
                <div><p className="font-semibold">{methodLabels[rule.method]}</p>
                  <p className="text-sm text-[var(--g-text-secondary)]">{rule.version === 0 ? "Nunca configurado" : `Versão ${rule.version}${rule.updatedAt ? ` · ${dateTime.format(new Date(rule.updatedAt))}` : ""}${rule.updatedByName ? ` · ${rule.updatedByName}` : ""}`}</p></div>
                <div className="flex items-center gap-2">
                  <Badge tone={rule.mode === "NONE" ? "neutral" : "info"}>{describe(rule)}</Badge>
                  <Button type="button" size="sm" variant="secondary" disabled={busy || editing !== null} onClick={() => setEditing({ method: rule.method, mode: rule.mode, value: "", reason: "" })}>Alterar</Button>
                </div>
              </div>}
          </li>)}
        </ul>}
    </Card>
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--g-border-subtle)] p-5">
        <div><h2 className="font-semibold">Histórico de versões</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">Versões nunca são editadas nem apagadas.</p></div>
        <label className="text-sm"><span className="sr-only">Filtrar por meio</span>
          <select className="g-input min-h-11" value={historyFilter} onChange={(event) => setHistoryFilter(event.target.value as PaymentSurchargeMethodKey | "ALL")}>
            <option value="ALL">Todos os meios</option>{(Object.keys(methodLabels) as PaymentSurchargeMethodKey[]).map((method) => <option key={method} value={method}>{methodLabels[method]}</option>)}
          </select></label>
      </div>
      {visibleHistory.length === 0 ? <p className="p-5 text-sm text-[var(--g-text-secondary)]">Nenhuma versão registrada.</p>
        : <div className="overflow-x-auto"><table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="text-xs uppercase text-[var(--g-text-muted)]"><tr><th className="px-5 py-3">Quando</th><th className="px-5 py-3">Meio</th><th className="px-5 py-3">Versão</th><th className="px-5 py-3">Regra</th><th className="px-5 py-3">Motivo</th><th className="px-5 py-3">Responsável</th></tr></thead>
          <tbody className="divide-y divide-[var(--g-border-subtle)]">{visibleHistory.map((item) => <tr key={item.ruleId}>
            <td className="px-5 py-3 whitespace-nowrap">{dateTime.format(new Date(item.createdAt))}</td><td className="px-5 py-3">{methodLabels[item.method]}</td>
            <td className="px-5 py-3">{item.version}</td><td className="px-5 py-3">{describe(item)}</td><td className="px-5 py-3">{item.reason}</td><td className="px-5 py-3">{item.createdByName}</td>
          </tr>)}</tbody>
        </table></div>}
    </Card>
  </div>;
}
