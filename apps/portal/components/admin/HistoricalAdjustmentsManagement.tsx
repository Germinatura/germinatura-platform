"use client";

import {
  cutoverCounterpartsResponseSchema, financeCategorySchema, historicalAdjustmentsResponseSchema,
  type CutoverCounterpart, type FinanceResultComponent, type HistoricalAdjustment,
} from "@germinatura/contracts";
import { parseBrlToCents } from "@germinatura/domain";
import { Badge, Button, Card, Field, Input, ReasonField } from "@germinatura/ui";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { useToast } from "@/components/ui/Toast";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const brl = (cents: number) => money.format(cents / 100);
const day = (value: string) => value.split("-").reverse().join("/");
const componentLabels: Record<FinanceResultComponent, string> = {
  RECEITA: "Receita", REEMBOLSO: "Reembolsos", TAXA: "Taxas", CMV: "CMV", PERDA: "Perdas", DESPESA_OPERACIONAL: "Despesa operacional",
};
const provenanceLabels: Record<string, string> = { HISTORICO_RECONSTRUIDO: "Histórico reconstruído", IMPORTADO: "Importado", IMPLANTACAO: "Implantação" };
const categories = financeCategorySchema.options.filter((value) => !["VENDA_PDV", "VENDA_ONLINE", "RESERVA", "RIFA"].includes(value));
type Lists = z.infer<typeof historicalAdjustmentsResponseSchema>["data"];
type Counterparts = z.infer<typeof cutoverCounterpartsResponseSchema>["data"];

async function messageFrom(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? fallback;
}

/**
 * PR E: historical adjustments without cash (one result component each; corrected only by reversal) and cutover
 * counterpart designations (management presentation; the original entries and the official result stay as they are).
 */
export function HistoricalAdjustmentsManagement() {
  const [adjustments, setAdjustments] = useState<Lists | null>(null);
  const [counterparts, setCounterparts] = useState<Counterparts | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    const [first, second] = await Promise.all([
      fetch("/api/v1/admin/finance/historical-adjustments", { cache: "no-store" }),
      fetch("/api/v1/admin/finance/cutover-counterparts", { cache: "no-store" }),
    ]);
    if (!first.ok) { setError(await messageFrom(first, "Não foi possível carregar os ajustes.")); return; }
    if (!second.ok) { setError(await messageFrom(second, "Não foi possível carregar as contrapartidas.")); return; }
    const parsedAdjustments = historicalAdjustmentsResponseSchema.safeParse(await first.json());
    const parsedCounterparts = cutoverCounterpartsResponseSchema.safeParse(await second.json());
    if (!parsedAdjustments.success || !parsedCounterparts.success) { setError("Os dados retornaram em formato inválido."); return; }
    setAdjustments(parsedAdjustments.data.data);
    setCounterparts(parsedCounterparts.data.data);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return <div className="grid gap-6">
    {error && <p role="alert" className="flex items-start gap-2 text-sm text-[var(--g-status-danger)]"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{error}</p>}
    {(!adjustments || !counterparts) && !error && <p role="status" className="flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Carregando…</p>}
    {adjustments && <AdjustmentsSection lists={adjustments} onChanged={load} />}
    {counterparts && <CounterpartsSection data={counterparts} onChanged={load} />}
  </div>;
}

function AdjustmentsSection({ lists, onChanged }: { lists: Lists; onChanged: () => Promise<void> }) {
  const { showToast } = useToast();
  const [component, setComponent] = useState<FinanceResultComponent>("CMV");
  const [direction, setDirection] = useState<"ACRESCIMO" | "REDUCAO">("ACRESCIMO");
  const [amount, setAmount] = useState("");
  const [competence, setCompetence] = useState("");
  const [category, setCategory] = useState("");
  const [justification, setJustification] = useState("");
  const [reference, setReference] = useState("");
  const [provenance, setProvenance] = useState("HISTORICO_RECONSTRUIDO");
  const [movements, setMovements] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [reversing, setReversing] = useState<{ id: string; reason: string } | null>(null);
  const keys = useRef(new Map<string, string>());
  const needsMovements = (component === "CMV" || component === "PERDA") && direction === "ACRESCIMO";
  const amountCents = useMemo(() => { try { return amount ? parseBrlToCents(amount) as number : null; } catch { return null; } }, [amount]);
  const chosenCost = lists.movements.filter((item) => movements.has(item.id)).reduce((sum, item) => sum + item.knownCostCents, 0);

  async function submit() {
    setMessage("");
    if (!amountCents || !competence) { setMessage("Informe valor e competência."); return; }
    const body = { component, direction, amountCents, competenceOn: competence, category: category || null, justification: justification.trim(),
      reference: reference.trim() || null, provenance, stockMovementIds: needsMovements ? [...movements] : [] };
    const signature = JSON.stringify(body);
    const key = keys.current.get(signature) ?? `historical-adjustment:${crypto.randomUUID()}`;
    keys.current.set(signature, key);
    setBusy(true);
    try {
      const response = await fetch("/api/v1/admin/finance/historical-adjustments", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });
      if (!response.ok) { setMessage(await messageFrom(response, "Não foi possível registrar o ajuste.")); return; }
      showToast("Ajuste histórico registrado. Nenhuma conta foi movimentada.", "success");
      setAmount(""); setJustification(""); setReference(""); setMovements(new Set());
      await onChanged();
    } finally { setBusy(false); }
  }

  async function reverse() {
    if (!reversing) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/admin/finance/historical-adjustments/${reversing.id}/reverse`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `historical-adjustment-reverse:${reversing.id}` },
        body: JSON.stringify({ reason: reversing.reason.trim() }),
      });
      if (!response.ok) { setMessage(await messageFrom(response, "Não foi possível reverter.")); return; }
      showToast("Ajuste revertido por um novo lançamento; o original continua no histórico.", "success");
      setReversing(null);
      await onChanged();
    } finally { setBusy(false); }
  }

  return <Card className="p-5"><section aria-label="Ajustes históricos sem caixa" className="grid gap-4">
    <div>
      <h2 className="font-semibold">Ajustes históricos sem caixa</h2>
      <p className="mt-1 text-sm text-[var(--g-text-secondary)]">Corrigem um componente do resultado anterior à operação no Germinatura{lists.operatingSince ? ` (antes de ${day(lists.operatingSince)})` : ""}. Não têm conta: não movimentam caixa, PicPay, recebíveis, pagamentos nem transferências. Correção só por reversão.</p>
    </div>
    <ul className="grid gap-2">{lists.items.length === 0 ? <li className="text-sm text-[var(--g-text-muted)]">Nenhum ajuste registrado.</li>
      : lists.items.map((item) => <AdjustmentItem key={item.id} item={item} onReverse={() => setReversing({ id: item.id, reason: "" })} />)}</ul>
    {reversing && <div role="group" aria-label="Reverter ajuste" className="grid gap-2 rounded-[var(--g-radius-card)] border border-[var(--g-status-warning)]/50 p-4">
      <ReasonField id="adjustment-reverse-reason" label="Motivo da reversão" minLength={8} maxLength={500} value={reversing.reason} onChange={(value) => setReversing({ ...reversing, reason: value })} />
      <div className="flex gap-2"><Button type="button" loading={busy} disabled={busy || reversing.reason.trim().length < 8} onClick={() => void reverse()}>Confirmar reversão</Button>
        <Button type="button" variant="ghost" onClick={() => setReversing(null)}>Cancelar</Button></div>
    </div>}
    <form className="grid gap-3 border-t border-[var(--g-border-subtle)] pt-4" onSubmit={(event) => { event.preventDefault(); void submit(); }} aria-label="Registrar ajuste histórico">
      <h3 className="font-semibold">Registrar ajuste</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field id="adjustment-component" label="Componente do resultado"><select id="adjustment-component" className="g-input min-h-11 w-full" value={component} onChange={(event) => setComponent(event.target.value as FinanceResultComponent)}>
          {Object.entries(componentLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        <Field id="adjustment-direction" label="Natureza"><select id="adjustment-direction" className="g-input min-h-11 w-full" value={direction} onChange={(event) => setDirection(event.target.value as "ACRESCIMO" | "REDUCAO")}>
          <option value="ACRESCIMO">Acréscimo ao componente</option><option value="REDUCAO">Redução do componente</option></select></Field>
        <Field id="adjustment-amount" label="Valor (R$)"><Input id="adjustment-amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="570,50" /></Field>
        <Field id="adjustment-competence" label="Competência"><Input id="adjustment-competence" type="date" value={competence} onChange={(event) => setCompetence(event.target.value)} /></Field>
        <Field id="adjustment-category" label="Categoria (opcional)"><select id="adjustment-category" className="g-input min-h-11 w-full" value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="">—</option>{categories.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
        <Field id="adjustment-provenance" label="Origem"><select id="adjustment-provenance" className="g-input min-h-11 w-full" value={provenance} onChange={(event) => setProvenance(event.target.value)}>
          {Object.entries(provenanceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      </div>
      <Field id="adjustment-reference" label="Referência (opcional)"><Input id="adjustment-reference" value={reference} maxLength={120} onChange={(event) => setReference(event.target.value)} /></Field>
      <ReasonField id="adjustment-justification" label="Justificativa" minLength={20} maxLength={1000} multiline value={justification} onChange={setJustification} />
      {needsMovements && <fieldset className="grid gap-1 text-sm">
        <legend className="font-semibold">Baixas de estoque que este custo reconhece</legend>
        {lists.movements.length === 0 ? <p className="text-[var(--g-text-muted)]">Nenhuma baixa por ajuste negativo.</p> : lists.movements.map((item) =>
          <label key={item.id} className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" disabled={item.coveredBy !== null} checked={movements.has(item.id)} onChange={() => setMovements((current) => {
              const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })} />
            <span>{day(item.movedOn)} · {item.units} un · custo conhecido <span className="g-money">{brl(item.knownCostCents)}</span>{item.unknownUnits > 0 ? ` · ${item.unknownUnits} un sem custo` : ""} · {item.reason ?? "sem motivo"}
              {item.coveredBy && <Badge tone="info" className="ml-1">Já reconhecida</Badge>}</span>
          </label>)}
        <p>Custo conhecido escolhido: <span className="g-money">{brl(chosenCost)}</span>{amountCents && amountCents > chosenCost ? " — o valor não pode passar dele." : ""}</p>
      </fieldset>}
      {message && <p role="alert" className="text-sm text-[var(--g-status-danger)]">{message}</p>}
      <div><Button type="submit" loading={busy} disabled={busy || justification.trim().length < 20 || !amountCents || !competence || (needsMovements && movements.size === 0)}>Registrar ajuste sem caixa</Button></div>
    </form>
  </section></Card>;
}

function AdjustmentItem({ item, onReverse }: { item: HistoricalAdjustment; onReverse: () => void }) {
  return <li className="rounded-[var(--g-radius-card)] border border-[var(--g-border-subtle)] p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="font-semibold">{item.reversalOf ? "Reversão · " : ""}{componentLabels[item.component]} · {item.direction === "ACRESCIMO" ? "acréscimo" : "redução"} de <span className="g-money">{brl(item.amountCents)}</span> · competência {day(item.competenceOn)}</span>
      <span className="flex flex-wrap items-center gap-2"><Badge tone="info">Sem impacto no caixa</Badge><span>Efeito no resultado: <span className="g-money">{brl(item.resultEffectCents)}</span></span>
        {!item.reversalOf && !item.reversedBy && <Button type="button" size="sm" variant="ghost" onClick={onReverse}>Reverter</Button>}
        {item.reversedBy && <Badge tone="neutral">Revertido</Badge>}</span>
    </div>
    <p className="mt-1 text-[var(--g-text-secondary)]">{item.reversalOf ? item.reversalReason : item.justification}</p>
    <p className="mt-1 text-xs text-[var(--g-text-muted)]">{provenanceLabels[item.provenance]} · {item.reference ?? "sem referência"} · {item.actorName}
      {item.stockMovements.length > 0 ? ` · reconhece ${item.stockMovements.length} baixa(s) de estoque` : ""}</p>
  </li>;
}

function CounterpartsSection({ data, onChanged }: { data: Counterparts; onChanged: () => Promise<void> }) {
  const { showToast } = useToast();
  const [counterpartId, setCounterpartId] = useState("");
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [revoking, setRevoking] = useState<{ id: string; reason: string } | null>(null);
  const keys = useRef(new Map<string, string>());
  const counterpart = data.counterpartCandidates.find((item) => item.id === counterpartId) ?? null;
  const chosenTarget = data.targetCandidates.find((item) => `${item.kind}:${item.id}` === target) ?? null;

  async function designate() {
    if (!counterpart || !chosenTarget) return;
    setMessage("");
    const body = { counterpartManualEntryId: counterpart.id, targetStatementLineId: chosenTarget.kind === "STATEMENT_LINE" ? chosenTarget.id : null,
      targetManualExpenseId: chosenTarget.kind === "MANUAL_EXPENSE" ? chosenTarget.id : null, neutralizedCents: counterpart.amountCents, reason: reason.trim() };
    const signature = JSON.stringify(body);
    const key = keys.current.get(signature) ?? `cutover-counterpart:${crypto.randomUUID()}`;
    keys.current.set(signature, key);
    setBusy(true);
    try {
      const response = await fetch("/api/v1/admin/finance/cutover-counterparts", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });
      if (!response.ok) { setMessage(await messageFrom(response, "Não foi possível designar.")); return; }
      showToast("Contrapartida designada. Resultado oficial e lançamentos não mudaram.", "success");
      setCounterpartId(""); setTarget(""); setReason("");
      await onChanged();
    } finally { setBusy(false); }
  }

  async function revoke() {
    if (!revoking) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/admin/finance/cutover-counterparts/${revoking.id}/revoke`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `cutover-counterpart-revoke:${revoking.id}` },
        body: JSON.stringify({ reason: revoking.reason.trim() }),
      });
      if (!response.ok) { setMessage(await messageFrom(response, "Não foi possível revogar.")); return; }
      showToast("Designação revogada; a apresentação volta aos lançamentos originais.", "success");
      setRevoking(null);
      await onChanged();
    } finally { setBusy(false); }
  }

  return <Card className="p-5"><section aria-label="Contrapartidas técnicas de cutover" className="grid gap-4">
    <div>
      <h2 className="font-semibold">Contrapartidas técnicas de cutover</h2>
      <p className="mt-1 text-sm text-[var(--g-text-secondary)]">Uma receita manual que existe só para neutralizar um efeito técnico do cutover sai da receita operacional e é apresentada contra a despesa que neutraliza. Classificação gerencial; lançamentos originais preservados. O resultado oficial, o caixa e os saldos não mudam. Nada é identificado por categoria, referência ou descrição: só pela designação explícita.</p>
    </div>
    <ul className="grid gap-2">{data.items.length === 0 ? <li className="text-sm text-[var(--g-text-muted)]">Nenhuma designação.</li>
      : data.items.map((item) => <DesignationItem key={item.id} item={item} onRevoke={() => setRevoking({ id: item.id, reason: "" })} />)}</ul>
    {revoking && <div role="group" aria-label="Revogar designação" className="grid gap-2 rounded-[var(--g-radius-card)] border border-[var(--g-status-warning)]/50 p-4">
      <ReasonField id="counterpart-revoke-reason" label="Motivo da revogação" minLength={8} maxLength={500} value={revoking.reason} onChange={(value) => setRevoking({ ...revoking, reason: value })} />
      <div className="flex gap-2"><Button type="button" loading={busy} disabled={busy || revoking.reason.trim().length < 8} onClick={() => void revoke()}>Confirmar revogação</Button>
        <Button type="button" variant="ghost" onClick={() => setRevoking(null)}>Cancelar</Button></div>
    </div>}
    <form className="grid gap-3 border-t border-[var(--g-border-subtle)] pt-4" aria-label="Designar contrapartida" onSubmit={(event) => { event.preventDefault(); void designate(); }}>
      <h3 className="font-semibold">Designar contrapartida</h3>
      <Field id="counterpart-entry" label="Contrapartida (receita manual anterior à operação)"><select id="counterpart-entry" className="g-input min-h-11 w-full" value={counterpartId} onChange={(event) => setCounterpartId(event.target.value)}>
        <option value="">Escolha…</option>{data.counterpartCandidates.map((item) => <option key={item.id} value={item.id}>{day(item.occurredOn)} · {brl(item.amountCents)} · {item.reference ?? "sem referência"} · {item.description}</option>)}</select></Field>
      <Field id="counterpart-target" label="Despesa neutralizada"><select id="counterpart-target" className="g-input min-h-11 w-full" value={target} onChange={(event) => setTarget(event.target.value)}>
        <option value="">Escolha…</option>{data.targetCandidates.map((item) => <option key={`${item.kind}:${item.id}`} value={`${item.kind}:${item.id}`} disabled={item.availableCents <= 0}>
          {day(item.occurredOn)} · {brl(item.amountCents)} (disponível {brl(item.availableCents)}) · {item.kind === "STATEMENT_LINE" ? "Extrato" : "Lançamento"} · {item.reference ?? ""} {item.description ?? ""}</option>)}</select></Field>
      {counterpart && chosenTarget && <p className="text-sm">Valor neutralizado: <span className="g-money font-semibold">{brl(counterpart.amountCents)}</span> (a contrapartida inteira).
        {counterpart.amountCents > chosenTarget.availableCents ? <span className="text-[var(--g-status-danger)]"> A despesa não comporta esse valor.</span>
          : ` Resta da despesa: ${brl(chosenTarget.availableCents - counterpart.amountCents)}.`}</p>}
      <ReasonField id="counterpart-reason" label="Justificativa" minLength={8} maxLength={500} value={reason} onChange={setReason} />
      {message && <p role="alert" className="text-sm text-[var(--g-status-danger)]">{message}</p>}
      <div><Button type="submit" loading={busy} disabled={busy || !counterpart || !chosenTarget || reason.trim().length < 8 || (counterpart.amountCents > chosenTarget.availableCents)}>Designar</Button></div>
    </form>
  </section></Card>;
}

function DesignationItem({ item, onRevoke }: { item: CutoverCounterpart; onRevoke: () => void }) {
  return <li className="rounded-[var(--g-radius-card)] border border-[var(--g-border-subtle)] p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="font-semibold">{item.counterpart.reference ?? "Contrapartida"} → {item.target.reference ?? "despesa"} · neutraliza <span className="g-money">{brl(item.neutralizedCents)}</span></span>
      <span className="flex items-center gap-2"><Badge tone={item.status === "ATIVA" ? "success" : item.status === "INVALIDA" ? "warning" : "neutral"}>
        {item.status === "ATIVA" ? "Ativa" : item.status === "INVALIDA" ? "Inválida — revisar" : "Revogada"}</Badge>
        {item.status !== "REVOGADA" && <Button type="button" size="sm" variant="ghost" onClick={onRevoke}>Revogar</Button>}</span>
    </div>
    <p className="mt-1">Despesa original: {day(item.target.occurredOn)} · <span className="g-money">{brl(item.target.amountCents)}</span> · {item.target.description}</p>
    <p>Contrapartida: {day(item.counterpart.occurredOn)} · <span className="g-money">{brl(item.counterpart.amountCents)}</span> · {item.counterpart.description}</p>
    <p className="text-[var(--g-text-secondary)]">{item.reason} · efeito no caixa {brl(item.cashEffectCents)} · efeito no resultado {brl(item.resultEffectCents)}</p>
    {item.revocation && <p className="text-[var(--g-text-muted)]">Revogada por {item.revocation.revokedBy}: {item.revocation.reason}</p>}
    <p className="mt-1 text-xs text-[var(--g-text-muted)]">classificação gerencial; lançamentos originais preservados</p>
  </li>;
}
