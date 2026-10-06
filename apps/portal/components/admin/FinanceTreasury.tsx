"use client";

import {
  financeBalanceCheckResponseSchema, financeBalanceChecksResponseSchema, financeOpeningPositionRecordedResponseSchema,
  financeOpeningPositionResponseSchema, type FinanceBalanceCheck, type FinanceOpeningPosition, type FinanceOpeningPositionResponse,
} from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FinanceBalancesSummary } from "@/components/admin/FinanceBalancesSummary";
import { useToast } from "@/components/ui/Toast";
import { parseReais } from "@/lib/money-input";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const formatMoney = (cents: number) => money.format(cents / 100);
const formatDay = (value: string) => value.split("-").reverse().join("/");
const formatTime = (value: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(new Date(value));
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const toReais = (cents: number) => (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });


async function messageFrom(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? fallback;
}

/** Spec 5.8 (FIN-002, FIN-003): balances, the cutover opening position and the balance check against PicPay. */
export function FinanceTreasury() {
  const [refresh, setRefresh] = useState(0);
  const reload = () => setRefresh((value) => value + 1);
  return <div className="grid gap-6">
    <FinanceBalancesSummary refreshKey={refresh} />
    <OpeningPositionPanel onChanged={reload} />
    <BalanceCheckPanel refreshKey={refresh} />
  </div>;
}

function useIdempotencyKeys(prefix: string) {
  const keys = useRef(new Map<string, string>());
  return useCallback((payload: unknown) => {
    const fingerprint = JSON.stringify(payload);
    const key = keys.current.get(fingerprint) ?? `${prefix}:${crypto.randomUUID()}`;
    keys.current.set(fingerprint, key);
    return key;
  }, [prefix]);
}

function OpeningPositionPanel({ onChanged }: { onChanged: () => void }) {
  const { showToast } = useToast();
  const keyFor = useIdempotencyKeys("opening-position");
  const [state, setState] = useState<FinanceOpeningPositionResponse["data"] | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ asOf: "", operatingSince: "", free: "0,00", vault: "0,00", receivables: "0,00", cash: "0,00", description: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/v1/admin/finance/opening-position", { cache: "no-store" });
    if (!response.ok) { setError(await messageFrom(response, "Não foi possível consultar a posição de abertura.")); return; }
    const parsed = financeOpeningPositionResponseSchema.safeParse(await response.json());
    if (!parsed.success) { setError("A consulta retornou dados inválidos."); return; }
    setState(parsed.data.data);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function startEditing(current: FinanceOpeningPosition | null) {
    setForm(current ? {
      asOf: current.asOf, operatingSince: current.operatingSince, free: toReais(current.accounts.PICPAY_EMPRESAS),
      vault: toReais(current.accounts.COFRINHO_PICPAY), receivables: toReais(current.accounts.RECEBIVEIS_PICPAY),
      cash: toReais(current.accounts.DINHEIRO_FISICO), description: current.description, reason: "",
    } : { asOf: "", operatingSince: "", free: "0,00", vault: "0,00", receivables: "0,00", cash: "0,00", description: "Posição de abertura do cutover PicPay", reason: "" });
    setError(""); setEditing(true);
  }

  async function submit() {
    const current = state?.current ?? null;
    const amounts = [form.free, form.vault, form.receivables, form.cash].map(parseReais);
    if (amounts.some((value) => value === null)) { setError("Informe os valores em reais, por exemplo 111,78."); return; }
    if (!form.asOf || !form.operatingSince || form.operatingSince <= form.asOf) { setError("O início da operação precisa ser depois do dia da abertura."); return; }
    if (current && form.reason.trim().length < 8) { setError("Explique o motivo da correção (pelo menos 8 caracteres)."); return; }
    const body = {
      asOf: form.asOf, operatingSince: form.operatingSince, freeCents: amounts[0], vaultCents: amounts[1], receivablesCents: amounts[2],
      cashCents: amounts[3], description: form.description.trim(), reason: current ? form.reason.trim() : null, supersedesId: current?.id ?? null,
    };
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/v1/admin/finance/opening-position", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": keyFor(body) }, body: JSON.stringify(body),
      });
      if (!response.ok) { setError(await messageFrom(response, "Não foi possível registrar a posição de abertura.")); return; }
      const parsed = financeOpeningPositionRecordedResponseSchema.safeParse(await response.json());
      if (!parsed.success) { setError("O registro retornou dados inválidos."); return; }
      showToast(`Posição de abertura registrada (versão ${parsed.data.data.version}).`, "success");
      setEditing(false);
      await load();
      onChanged();
    } finally { setBusy(false); }
  }

  const current = state?.current ?? null;
  const field = (id: keyof typeof form, label: string, props: { type?: string; inputMode?: "decimal" } = {}) =>
    <Field id={`opening-${id}`} label={label}><Input id={`opening-${id}`} type={props.type ?? "text"} inputMode={props.inputMode} value={form[id]} onChange={(event) => setForm((value) => ({ ...value, [id]: event.target.value }))} /></Field>;
  return <Card className="p-5">
    <section aria-label="Posição de abertura">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Posição de abertura</h2>
          <p className="mt-1 max-w-2xl text-sm text-[var(--g-text-secondary)]">Dinheiro que já existia em cada conta no início do dia da abertura. Compõe o saldo e aparece no extrato, mas nunca é receita, despesa, transferência, resultado ou meta. Linhas do extrato anteriores ao início da operação são histórico do cutover.</p>
        </div>
        {!editing && state && <Button type="button" variant={current ? "ghost" : "brand"} onClick={() => startEditing(current)}>{current ? "Corrigir abertura" : "Registrar abertura"}</Button>}
      </div>
      {!state && !error && <p role="status" className="mt-3 flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Carregando…</p>}
      {current && !editing && <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div><dt className="text-[var(--g-text-muted)]">Abertura</dt><dd className="font-semibold">{formatDay(current.asOf)} (versão {current.version})</dd></div>
        <div><dt className="text-[var(--g-text-muted)]">Operação no Germinatura desde</dt><dd className="font-semibold">{formatDay(current.operatingSince)}</dd></div>
        <div><dt className="text-[var(--g-text-muted)]">Registrada por</dt><dd>{current.actorName} · {formatTime(current.createdAt)}</dd></div>
        <div><dt className="text-[var(--g-text-muted)]">Saldo livre</dt><dd className="g-money font-semibold">{formatMoney(current.accounts.PICPAY_EMPRESAS)}</dd></div>
        <div><dt className="text-[var(--g-text-muted)]">Cofrinho</dt><dd className="g-money font-semibold">{formatMoney(current.accounts.COFRINHO_PICPAY)}</dd></div>
        <div><dt className="text-[var(--g-text-muted)]">Recebíveis · Dinheiro físico</dt><dd className="g-money font-semibold">{formatMoney(current.accounts.RECEBIVEIS_PICPAY)} · {formatMoney(current.accounts.DINHEIRO_FISICO)}</dd></div>
      </dl>}
      {state && !current && !editing && <p className="mt-3 text-sm text-[var(--g-text-secondary)]">Nenhuma posição de abertura registrada.</p>}
      {editing && <div className="mt-4 grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          {field("asOf", "Dia da abertura", { type: "date" })}
          {field("operatingSince", "Operação no Germinatura desde", { type: "date" })}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {field("free", "Saldo livre (R$)", { inputMode: "decimal" })}
          {field("vault", "Cofrinho (R$)", { inputMode: "decimal" })}
          {field("receivables", "Recebíveis (R$)", { inputMode: "decimal" })}
          {field("cash", "Dinheiro físico (R$)", { inputMode: "decimal" })}
        </div>
        {field("description", "Descrição")}
        {current && field("reason", "Motivo da correção")}
        <p className="text-xs text-[var(--g-text-muted)]">{current ? "A correção cria uma nova versão; a anterior continua no histórico." : "A abertura é registrada uma única vez; depois, só por correção com motivo."}</p>
        <div className="flex gap-2"><Button type="button" loading={busy} disabled={busy} onClick={() => void submit()}>{current ? "Registrar correção" : "Registrar abertura"}</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>Cancelar</Button></div>
      </div>}
      {error && <p role="alert" className="mt-3 text-sm font-semibold text-[var(--g-status-danger)]">{error}</p>}
      {state && state.versions.length > 1 && <details className="mt-4 text-sm"><summary className="cursor-pointer font-medium">Versões anteriores</summary><ul className="mt-2 grid gap-1">
        {state.versions.slice(1).map((version) => <li key={version.id}>Versão {version.version} · {formatDay(version.asOf)} · Cofrinho {formatMoney(version.accounts.COFRINHO_PICPAY)} · {version.actorName} · {formatTime(version.createdAt)}{version.reason ? ` · ${version.reason}` : ""}</li>)}
      </ul></details>}
    </section>
  </Card>;
}

function BalanceCheckPanel({ refreshKey }: { refreshKey: number }) {
  const { showToast } = useToast();
  const keyFor = useIdempotencyKeys("balance-check");
  const [form, setForm] = useState({ asOf: today(), free: "", vault: "", note: "" });
  const [result, setResult] = useState<FinanceBalanceCheck | null>(null);
  const [history, setHistory] = useState<FinanceBalanceCheck[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadHistory = useCallback(async () => {
    const response = await fetch("/api/v1/admin/finance/balance-checks", { cache: "no-store" });
    if (!response.ok) return;
    const parsed = financeBalanceChecksResponseSchema.safeParse(await response.json());
    if (parsed.success) setHistory(parsed.data.data);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void loadHistory(), 0);
    return () => window.clearTimeout(timer);
  }, [loadHistory, refreshKey]);

  async function submit() {
    const free = parseReais(form.free);
    const vault = parseReais(form.vault);
    if (free === null || vault === null) { setError("Informe o saldo livre e o Cofrinho vistos no PicPay, em reais."); return; }
    const body = { asOf: form.asOf, observedFreeCents: free, observedVaultCents: vault, note: form.note.trim() || null };
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/v1/admin/finance/balance-checks", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": keyFor(body) }, body: JSON.stringify(body),
      });
      if (!response.ok) { setError(await messageFrom(response, "Não foi possível registrar a conferência.")); return; }
      const parsed = financeBalanceCheckResponseSchema.safeParse(await response.json());
      if (!parsed.success) { setError("A conferência retornou dados inválidos."); return; }
      setResult(parsed.data.data);
      showToast(parsed.data.data.status === "CONCILIADO" ? "Saldo conciliado." : "Conferência registrada com diferença.", parsed.data.data.status === "CONCILIADO" ? "success" : "info");
      await loadHistory();
    } finally { setBusy(false); }
  }

  return <Card className="p-5">
    <section aria-label="Conferência de saldo">
      <h2 className="font-semibold">Conferência de saldo</h2>
      <p className="mt-1 max-w-2xl text-sm text-[var(--g-text-secondary)]">Informe o saldo livre e o Cofrinho que aparecem no app do PicPay Empresas. A diferença nunca vira ajuste automático: ela fica registrada para investigação.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field id="check-as-of" label="Dia"><Input id="check-as-of" type="date" value={form.asOf} max={today()} onChange={(event) => setForm((value) => ({ ...value, asOf: event.target.value }))} /></Field>
        <Field id="check-free" label="Saldo livre real (R$)"><Input id="check-free" inputMode="decimal" value={form.free} onChange={(event) => setForm((value) => ({ ...value, free: event.target.value }))} /></Field>
        <Field id="check-vault" label="Cofrinho real (R$)"><Input id="check-vault" inputMode="decimal" value={form.vault} onChange={(event) => setForm((value) => ({ ...value, vault: event.target.value }))} /></Field>
        <Field id="check-note" label="Observação (opcional)"><Input id="check-note" maxLength={500} value={form.note} onChange={(event) => setForm((value) => ({ ...value, note: event.target.value }))} /></Field>
      </div>
      <div className="mt-3"><Button type="button" loading={busy} disabled={busy} onClick={() => void submit()}>Conferir saldo</Button></div>
      {error && <p role="alert" className="mt-3 text-sm font-semibold text-[var(--g-status-danger)]">{error}</p>}
      {result && <div aria-label="Resultado da conferência" className={`mt-4 rounded-[var(--g-radius-card)] border p-4 text-sm ${result.status === "CONCILIADO" ? "border-[var(--g-status-success)]" : "border-[var(--g-status-danger)]"}`}>
        <p className="flex items-center gap-2 font-semibold">{result.status === "CONCILIADO" ? <CheckCircle2 className="size-5 text-[var(--g-status-success)]" /> : <AlertTriangle className="size-5 text-[var(--g-status-danger)]" />}Status: {result.status}</p>
        <table className="mt-3 w-full text-left">
          <caption className="sr-only">Calculado pelo Germinatura e observado no PicPay</caption>
          <thead><tr className="text-[var(--g-text-muted)]"><th className="py-1 pr-3 font-medium">Conta</th><th className="py-1 pr-3 font-medium">Germinatura</th><th className="py-1 pr-3 font-medium">PicPay</th><th className="py-1 font-medium">Diferença</th></tr></thead>
          <tbody>
            <tr className="border-t border-[var(--g-border-subtle)]"><td className="py-1 pr-3">Saldo livre</td><td className="g-money py-1 pr-3">{formatMoney(result.computedFreeCents)}</td><td className="g-money py-1 pr-3">{formatMoney(result.observedFreeCents)}</td><td className="g-money py-1">{formatMoney(result.freeDifferenceCents)}</td></tr>
            <tr className="border-t border-[var(--g-border-subtle)]"><td className="py-1 pr-3">Cofrinho</td><td className="g-money py-1 pr-3">{formatMoney(result.computedVaultCents)}</td><td className="g-money py-1 pr-3">{formatMoney(result.observedVaultCents)}</td><td className="g-money py-1">{formatMoney(result.vaultDifferenceCents)}</td></tr>
            <tr className="border-t border-[var(--g-border-subtle)] font-semibold"><td className="py-1 pr-3">Total</td><td className="g-money py-1 pr-3">{formatMoney(result.computedTotalCents)}</td><td className="g-money py-1 pr-3">{formatMoney(result.observedTotalCents)}</td><td className="g-money py-1">{formatMoney(result.totalDifferenceCents)}</td></tr>
          </tbody>
        </table>
        {result.status === "DIVERGENTE" && <p className="mt-3">Investigue antes de ajustar: {result.statementLines.pending.count} linha(s) do extrato pendentes ({formatMoney(result.statementLines.pending.netCents)}), {result.statementLines.alreadyRecorded.count} marcada(s) como já registradas e {result.statementLines.linked.count} vinculada(s). Um ajuste, se necessário, é um lançamento manual explícito com motivo.</p>}
      </div>}
      {history && history.length > 0 && <div className="mt-5"><h3 className="text-sm font-semibold">Conferências registradas</h3><ul aria-label="Conferências registradas" className="mt-2 divide-y divide-[var(--g-border-subtle)] text-sm">
        {history.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span>Nº {item.number} · {formatDay(item.asOf)} · total {formatMoney(item.computedTotalCents)} · diferença {formatMoney(item.totalDifferenceCents)} · {item.actorName} · {formatTime(item.createdAt)}</span>
          <Badge tone={item.status === "CONCILIADO" ? "success" : "danger"}>{item.status === "CONCILIADO" ? "Conciliado" : "Divergente"}</Badge>
        </li>)}
      </ul></div>}
    </section>
  </Card>;
}
