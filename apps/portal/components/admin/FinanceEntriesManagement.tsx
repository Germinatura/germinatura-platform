"use client";

import {
  automaticFinanceCategories, statementOnlyFinanceCategories, financeAccountSchema, financeCategorySchema, financeEntriesResponseSchema, financeEntryResponseSchema,
  recordFinanceEntryRequestSchema, type FinanceAccount, type FinanceCategory, type FinanceEntriesResponse, type FinanceEntry,
} from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, Loader2, Plus, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { financeAccountLabels as accountLabels, financeCategoryLabels as categoryLabels } from "@/lib/finance-labels";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const formatMoney = (cents: number) => money.format(cents / 100);
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const formatDay = (value: string) => value.split("-").reverse().join("/");

const kindLabels: Record<FinanceEntry["kind"], string> = { EXPENSE: "Despesa", INCOME: "Receita", TRANSFER: "Transferência", REVERSAL: "Estorno" };
const manualCategories = financeCategorySchema.options.filter((category) => !automaticFinanceCategories.includes(category)
  && !statementOnlyFinanceCategories.includes(category));
const accounts = financeAccountSchema.options;

function parseCents(value: string): number | null {
  const match = value.trim().replace(/\.(?=\d{3}(\D|$))/g, "").match(/^(\d{1,13})(?:,(\d{1,2}))?$/);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

async function messageFrom(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? fallback;
}

function entryLine(entry: FinanceEntry, byId: Map<string, FinanceEntry>) {
  const source = entry.kind === "REVERSAL" && entry.reversalOf ? byId.get(entry.reversalOf) : entry;
  const accountsText = entry.counterAccount ? `${accountLabels[entry.account]} → ${accountLabels[entry.counterAccount]}` : accountLabels[entry.account];
  const category = entry.category ? categoryLabels[entry.category] : source?.kind === "TRANSFER" || entry.kind === "TRANSFER" ? "Tesouraria" : "";
  return [category, accountsText].filter(Boolean).join(" · ");
}

/** Spec 5.8: audited manual expenses, incomes and treasury transfers on the simplified plan. */
export function FinanceEntriesManagement() {
  const { showToast } = useToast();
  const monthStart = `${today().slice(0, 8)}01`;
  const [period, setPeriod] = useState({ from: monthStart, to: today() });
  const [result, setResult] = useState<FinanceEntriesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ kind: "EXPENSE" as "EXPENSE" | "INCOME" | "TRANSFER", category: "" as FinanceCategory | "", account: "PICPAY_EMPRESAS" as FinanceAccount, counterAccount: "" as FinanceAccount | "", amount: "", occurredOn: today(), description: "", reference: "" });
  const [saving, setSaving] = useState(false);
  const [reversing, setReversing] = useState<{ id: string; reason: string } | null>(null);
  const [busyReverse, setBusyReverse] = useState(false);
  const keys = useRef(new Map<string, string>());
  const keyFor = (scope: string, payload: unknown) => {
    const fingerprint = `${scope}:${JSON.stringify(payload)}`;
    const key = keys.current.get(fingerprint) ?? `finance-entry-${scope}:${crypto.randomUUID()}`;
    keys.current.set(fingerprint, key);
    return key;
  };

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/v1/admin/finance/entries?${new URLSearchParams(period)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível carregar os lançamentos."));
      const parsed = financeEntriesResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("A consulta retornou dados inválidos.");
      setResult(parsed.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar os lançamentos."); }
    finally { setLoading(false); }
  }, [period]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 250); return () => window.clearTimeout(timer); }, [load]);

  const payload = {
    kind: form.kind, category: form.kind === "TRANSFER" ? null : form.category || null, account: form.account,
    counterAccount: form.kind === "TRANSFER" ? form.counterAccount || null : null, amountCents: parseCents(form.amount) ?? 0,
    occurredOn: form.occurredOn, description: form.description.trim(), reference: form.reference.trim() || null,
  };
  const valid = recordFinanceEntryRequestSchema.safeParse(payload);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid.success) { setError(valid.error.issues[0]?.message ?? "Confira os dados do lançamento."); return; }
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/v1/admin/finance/entries", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": keyFor("record", valid.data) }, body: JSON.stringify(valid.data),
      });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível registrar o lançamento."));
      if (!financeEntryResponseSchema.safeParse(await response.json()).success) throw new Error("O lançamento retornou dados inválidos.");
      showToast("Lançamento registrado.", "success");
      setForm({ ...form, amount: "", description: "", reference: "" });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível registrar o lançamento."); }
    finally { setSaving(false); }
  }

  async function reverse() {
    if (!reversing || reversing.reason.trim().length < 8) return;
    setBusyReverse(true); setError("");
    try {
      const body = { reason: reversing.reason.trim() };
      const response = await fetch(`/api/v1/admin/finance/entries/${reversing.id}/reverse`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": keyFor(`reverse-${reversing.id}`, body) }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível estornar o lançamento."));
      showToast("Lançamento estornado.", "success");
      setReversing(null);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível estornar o lançamento."); }
    finally { setBusyReverse(false); }
  }

  const entries = result?.data ?? [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return <div className="grid gap-6">
    <Card className="p-5">
      <h2 className="font-semibold">Novo lançamento</h2>
      <p className="mt-1 text-sm text-[var(--g-text-secondary)]">Receitas de vendas, reservas e rifas entram sozinhas pelas vendas. Aqui ficam despesas, outras receitas e transferências entre contas, que não são receita.</p>
      <form aria-label="Novo lançamento" onSubmit={submit} className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field id="entry-kind" label="Tipo"><select id="entry-kind" className="g-input min-h-11 w-full" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as typeof form.kind })}><option value="EXPENSE">Despesa</option><option value="INCOME">Receita</option><option value="TRANSFER">Transferência entre contas</option></select></Field>
        {form.kind !== "TRANSFER" && <Field id="entry-category" label="Categoria"><select id="entry-category" className="g-input min-h-11 w-full" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value as FinanceCategory })}><option value="">Selecione</option>{manualCategories.map((category) => <option key={category} value={category}>{categoryLabels[category]}</option>)}</select></Field>}
        <Field id="entry-account" label={form.kind === "TRANSFER" ? "Conta de origem" : "Conta"}><select id="entry-account" className="g-input min-h-11 w-full" value={form.account} onChange={(event) => setForm({ ...form, account: event.target.value as FinanceAccount })}>{accounts.map((account) => <option key={account} value={account}>{accountLabels[account]}</option>)}</select></Field>
        {form.kind === "TRANSFER" && <Field id="entry-counter-account" label="Conta de destino"><select id="entry-counter-account" className="g-input min-h-11 w-full" value={form.counterAccount} onChange={(event) => setForm({ ...form, counterAccount: event.target.value as FinanceAccount })}><option value="">Selecione</option>{accounts.filter((account) => account !== form.account).map((account) => <option key={account} value={account}>{accountLabels[account]}</option>)}</select></Field>}
        <Field id="entry-amount" label="Valor (R$)"><Input id="entry-amount" inputMode="decimal" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} placeholder="Ex.: 150,00" /></Field>
        <Field id="entry-date" label="Data"><Input id="entry-date" type="date" max={today()} value={form.occurredOn} onChange={(event) => setForm({ ...form, occurredOn: event.target.value })} /></Field>
        <Field id="entry-description" label="Descrição" className="sm:col-span-2"><Input id="entry-description" maxLength={300} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
        <Field id="entry-reference" label="Referência (opcional)" description="Nota, comprovante ou documento, sem dados de cartão."><Input id="entry-reference" maxLength={128} value={form.reference} onChange={(event) => setForm({ ...form, reference: event.target.value })} /></Field>
        <div className="flex items-end"><Button type="submit" className="w-full" loading={saving} disabled={saving || !valid.success}><Plus className="size-4" />Registrar</Button></div>
      </form>
    </Card>
    <Card className="p-5">
      <div className="flex flex-wrap items-end gap-4">
        <Field id="entries-from" label="De"><Input id="entries-from" type="date" value={period.from} onChange={(event) => setPeriod({ ...period, from: event.target.value })} /></Field>
        <Field id="entries-to" label="Até"><Input id="entries-to" type="date" value={period.to} onChange={(event) => setPeriod({ ...period, to: event.target.value })} /></Field>
      </div>
      {result && <dl aria-label="Resumo do período" className="mt-5 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><dt className="text-[var(--g-text-muted)]">Entradas</dt><dd className="g-money text-lg font-bold">{formatMoney(result.totals.inflowCents)}</dd></div>
        <div><dt className="text-[var(--g-text-muted)]">Saídas</dt><dd className="g-money text-lg font-bold">{formatMoney(result.totals.outflowCents)}</dd></div>
        {accounts.filter((account) => result.totals.byAccount[account] !== undefined).map((account) => <div key={account}><dt className="text-[var(--g-text-muted)]">{accountLabels[account]}</dt><dd className="g-money font-semibold">{formatMoney(result.totals.byAccount[account] ?? 0)}</dd></div>)}
      </dl>}
    </Card>
    {error && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 p-4 text-sm"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--g-status-danger)]" /><p>{error}</p></div>}
    <Card className="overflow-hidden">
      {loading && !result ? <p role="status" className="flex items-center gap-2 p-5 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Carregando lançamentos…</p>
        : entries.length === 0 ? <p className="p-5 text-sm text-[var(--g-text-secondary)]">Nenhum lançamento manual no período.</p>
        : <ul aria-label="Lançamentos" className="divide-y divide-[var(--g-border-subtle)]">
          {entries.map((entry) => {
            const sign = entry.kind === "EXPENSE" ? "−" : entry.kind === "INCOME" ? "+" : "";
            return <li key={entry.id} aria-label={`Lançamento ${entry.description}`} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">{entry.description}</p>
                  <p className="text-sm text-[var(--g-text-secondary)]">{formatDay(entry.occurredOn)} · {entryLine(entry, byId)}{entry.reference ? ` · ${entry.reference}` : ""} · {entry.actorName}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={entry.kind === "REVERSAL" ? "danger" : entry.kind === "TRANSFER" ? "info" : "neutral"}>{kindLabels[entry.kind]}</Badge>
                  <span className="g-money font-bold">{sign}{formatMoney(entry.amountCents)}</span>
                </div>
              </div>
              {entry.reversedBy && <p className="mt-2 text-xs text-[var(--g-text-muted)]">Estornado.</p>}
              {entry.kind !== "REVERSAL" && !entry.reversedBy && (reversing?.id === entry.id
                ? <div className="mt-3 flex flex-wrap items-end gap-2"><Field id={`reverse-reason-${entry.id}`} label="Motivo do estorno" className="min-w-64 flex-1"><Input id={`reverse-reason-${entry.id}`} maxLength={300} value={reversing.reason} onChange={(event) => setReversing({ id: entry.id, reason: event.target.value })} /></Field>
                  <Button type="button" size="sm" variant="danger" loading={busyReverse} disabled={busyReverse || reversing.reason.trim().length < 8} onClick={() => void reverse()}>Confirmar estorno</Button>
                  <Button type="button" size="sm" variant="ghost" disabled={busyReverse} onClick={() => setReversing(null)}>Cancelar</Button></div>
                : <Button type="button" size="sm" variant="ghost" className="mt-2" onClick={() => setReversing({ id: entry.id, reason: "" })}><RotateCcw className="size-4" />Estornar</Button>)}
            </li>;
          })}
        </ul>}
    </Card>
  </div>;
}
