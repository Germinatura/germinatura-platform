"use client";

import { fundraisingGoalRequestSchema, fundraisingGoalResponseSchema, type FundraisingGoal } from "@germinatura/contracts";
import { Button, Card, Field, Input } from "@germinatura/ui";
import { useEffect, useRef, useState } from "react";
import { FundraisingGoalProgress } from "@/components/goal/FundraisingGoalProgress";
import { useToast } from "@/components/ui/Toast";

const parseReais = (value: string) => {
  const normalized = value.replace(/\s|R\$/g, "").replace(/\./g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
};
const toReais = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");

/** ADMIN-002 (spec 5.17): target, dates and what the class sees of the fundraising goal. */
export function FundraisingGoalSettings() {
  const { showToast } = useToast();
  const [goal, setGoal] = useState<FundraisingGoal | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [target, setTarget] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [publicVisible, setPublicVisible] = useState(false);
  const [showAmounts, setShowAmounts] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const keys = useRef(new Map<string, string>());

  function apply(value: FundraisingGoal | null) {
    setGoal(value);
    if (!value) return;
    if (value.targetCents !== null) setTarget(toReais(value.targetCents));
    setFrom(value.countingFrom); setTo(value.targetDate);
    setPublicVisible(Boolean(value.publicVisible)); setShowAmounts(value.showAmounts);
  }

  useEffect(() => {
    void fetch("/api/v1/admin/settings/fundraising-goal", { cache: "no-store" }).then(async (response) => {
      const parsed = fundraisingGoalResponseSchema.safeParse(await response.json().catch(() => null));
      if (!response.ok || !parsed.success) throw new Error("Não foi possível carregar a meta.");
      apply(parsed.data.data);
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Não foi possível carregar a meta.")).finally(() => setLoaded(true));
  }, []);

  const request = fundraisingGoalRequestSchema.safeParse({ targetCents: parseReais(target), countingFrom: from, targetDate: to, publicVisible, showAmounts });

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!request.success) { setError("Informe a meta em reais e datas válidas (a data-alvo depois do início)."); return; }
    const fingerprint = JSON.stringify(request.data);
    const key = keys.current.get(fingerprint) ?? `goal:${crypto.randomUUID()}`;
    keys.current.set(fingerprint, key);
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/v1/admin/settings/fundraising-goal", {
        method: "PUT", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(request.data),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error((body as { message?: string } | null)?.message ?? "Não foi possível salvar a meta.");
      const parsed = fundraisingGoalResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error("A meta retornou dados inválidos.");
      apply(parsed.data.data);
      showToast("Meta salva.", "success");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar a meta."); }
    finally { setBusy(false); }
  }

  return <Card className="grid gap-6 p-5 lg:grid-cols-2">
    <form aria-label="Meta de arrecadação" className="grid gap-4" onSubmit={(event) => void save(event)}>
      <div><h2 className="text-lg font-semibold">Meta de arrecadação</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">O progresso é o lucro operacional desde o início da contagem: vendas, rifas e eventos menos custo real, perdas e despesas.</p></div>
      <Field id="goal-target" label="Meta (R$)"><Input id="goal-target" inputMode="decimal" value={target} onChange={(event) => setTarget(event.target.value)} placeholder="Ex.: 50.000,00" /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="goal-from" label="Início da contagem"><Input id="goal-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></Field>
        <Field id="goal-to" label="Data-alvo"><Input id="goal-to" type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} /></Field>
      </div>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={publicVisible} onChange={(event) => setPublicVisible(event.target.checked)} /><span>Mostrar o progresso na página inicial da turma</span></label>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={showAmounts} onChange={(event) => setShowAmounts(event.target.checked)} /><span>Mostrar valores em reais (desmarcado, a turma vê só os percentuais)</span></label>
      {error && <p role="alert" className="text-sm text-[var(--g-status-danger)]">{error}</p>}
      <Button type="submit" variant="brand" loading={busy} disabled={busy || !loaded}>Salvar meta</Button>
    </form>
    <section aria-label="Progresso atual">{!loaded ? <p role="status" className="text-sm">Carregando…</p>
      : goal ? <FundraisingGoalProgress goal={goal} title="Progresso atual" />
      : <p className="text-sm text-[var(--g-text-secondary)]">Nenhuma meta configurada ainda.</p>}</section>
  </Card>;
}
