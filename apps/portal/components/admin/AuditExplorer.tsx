"use client";

import { COHORT_HEADER, auditCorrelationResponseSchema, auditSearchResponseSchema, type AuditCorrelation, type AuditEntry, type AuditSeverity, type CohortSummary } from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "medium", timeZone: "America/Sao_Paulo" });
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const severityLabels: Record<AuditSeverity, { label: string; tone: "danger" | "warning" | "neutral" }> = {
  HIGH: { label: "Alta", tone: "danger" }, MEDIUM: { label: "Média", tone: "warning" }, LOW: { label: "Baixa", tone: "neutral" },
};
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
function shift(day: string, days: number) { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }

type Filters = { from: string; to: string; actor: string; action: string; entityType: string; entityId: string; correlationId: string; severity: string; cohort: string };

async function readError(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? fallback;
}

/**
 * AUD-001 (spec 5.16): investigate what happened — by user, action, entity, period, severity and correlation.
 * ADR 0011 (PR 4): in "Todas as turmas" (`cohorts` given) every record shows its cohort ("Global" for global operations)
 * and the cohort filter reads inside the chosen cohort.
 */
export function AuditExplorer({ cohorts }: { cohorts?: CohortSummary[] } = {}) {
  const consolidated = Boolean(cohorts);
  const cohortLabel = (row: AuditEntry) => (row.cohortId === null ? "Global" : cohorts?.find((cohort) => cohort.id === row.cohortId)?.name ?? "—");
  const [filters, setFilters] = useState<Filters>(() => ({ from: shift(today(), -6), to: today(), actor: "", action: "", entityType: "", entityId: "", correlationId: "", severity: "", cohort: "" }));
  const [applied, setApplied] = useState(filters);
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [correlation, setCorrelation] = useState<AuditCorrelation | null>(null);

  const load = useCallback(async (after?: { createdAt: string; id: string }) => {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ from: applied.from, to: applied.to });
      for (const key of ["actor", "action", "entityType", "entityId", "correlationId", "severity"] as const) if (applied[key].trim()) params.set(key, applied[key].trim());
      if (after) { params.set("cursorCreatedAt", after.createdAt); params.set("cursorId", after.id); }
      const response = await fetch(`/api/v1/admin/audit?${params}`, { cache: "no-store", headers: applied.cohort ? { [COHORT_HEADER]: applied.cohort } : undefined });
      if (!response.ok) throw new Error(await readError(response, "Não foi possível consultar a auditoria."));
      const parsed = auditSearchResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("A auditoria retornou dados inválidos.");
      setRows((current) => after ? [...current, ...parsed.data.data] : parsed.data.data);
      setCursor(parsed.data.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível consultar a auditoria."); }
    finally { setLoading(false); }
  }, [applied]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function openCorrelation(id: string) {
    setError("");
    try {
      const response = await fetch(`/api/v1/admin/audit/correlations/${id}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "Não foi possível abrir a correlação."));
      const parsed = auditCorrelationResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("A correlação retornou dados inválidos.");
      setCorrelation(parsed.data.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível abrir a correlação."); }
  }

  const set = (key: keyof Filters) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFilters({ ...filters, [key]: event.target.value });
  return <div className="grid gap-6">
    <Card className="p-5">
      <form aria-label="Filtrar auditoria" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(event) => { event.preventDefault(); setCorrelation(null); setApplied(filters); }}>
        {consolidated && <Field id="audit-cohort" label="Turma"><select id="audit-cohort" className="g-input min-h-11 w-full" value={filters.cohort} onChange={set("cohort")}><option value="">Todas (inclui operações globais)</option>{cohorts?.map((cohort) => <option key={cohort.id} value={cohort.id}>{cohort.name}</option>)}</select></Field>}
        <Field id="audit-from" label="De"><Input id="audit-from" type="date" value={filters.from} onChange={set("from")} /></Field>
        <Field id="audit-to" label="Até"><Input id="audit-to" type="date" value={filters.to} onChange={set("to")} /></Field>
        <Field id="audit-actor" label="Usuário"><Input id="audit-actor" value={filters.actor} maxLength={80} onChange={set("actor")} placeholder="nome, e-mail ou usuário" /></Field>
        <Field id="audit-severity" label="Severidade"><select id="audit-severity" className="g-input min-h-11 w-full" value={filters.severity} onChange={set("severity")}><option value="">Todas</option><option value="HIGH">Alta</option><option value="MEDIUM">Média</option><option value="LOW">Baixa</option></select></Field>
        <Field id="audit-action" label="Ação (começa com)"><Input id="audit-action" value={filters.action} maxLength={100} onChange={set("action")} placeholder="ex.: sales." /></Field>
        <Field id="audit-entity-type" label="Tipo de entidade"><Input id="audit-entity-type" value={filters.entityType} maxLength={64} onChange={set("entityType")} placeholder="ex.: sale" /></Field>
        <Field id="audit-entity-id" label="Identificador da entidade"><Input id="audit-entity-id" value={filters.entityId} maxLength={128} onChange={set("entityId")} /></Field>
        <Field id="audit-correlation" label="Correlação"><Input id="audit-correlation" value={filters.correlationId} maxLength={36} onChange={set("correlationId")} /></Field>
        <div className="sm:col-span-2 lg:col-span-4"><Button type="submit" variant="brand" disabled={loading}><Search className="size-4" />Pesquisar</Button></div>
      </form>
      <p className="mt-3 text-xs text-[var(--g-text-muted)]">Somente leitura. Horários de Brasília; período de até um ano.</p>
    </Card>

    {error && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 p-4 text-sm"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--g-status-danger)]" /><p>{error}</p></div>}
    {correlation && <CorrelationView correlation={correlation} onClose={() => setCorrelation(null)} />}

    <Card className="overflow-hidden">
      {loading && rows.length === 0 ? <p role="status" className="p-5 text-sm">Consultando…</p>
        : rows.length === 0 ? <p className="p-5 text-sm text-[var(--g-text-secondary)]">Nenhum registro com esses filtros.</p>
        : <ul aria-label="Registros de auditoria" className="divide-y divide-[var(--g-border-subtle)]">{rows.map((row) => <li key={row.id} aria-label={`${row.action} em ${row.entityType}`} className="p-4 text-sm">
          <div className="flex flex-wrap items-center gap-2"><Badge tone={severityLabels[row.severity].tone}>{severityLabels[row.severity].label}</Badge><code className="font-semibold">{row.action}</code><span className="text-[var(--g-text-muted)]">{dateTime.format(new Date(row.createdAt))}</span>{consolidated && <Badge tone="info">{cohortLabel(row)}</Badge>}</div>
          <p className="mt-1 text-[var(--g-text-secondary)]">{row.actorName ?? "Sistema"} · {row.entityType} <code className="break-all">{row.entityId}</code></p>
          <div className="mt-2 flex flex-wrap gap-2">
            {row.correlationId && <Button type="button" size="sm" variant="secondary" onClick={() => void openCorrelation(row.correlationId as string)}>Ver correlação</Button>}
            <details><summary className="cursor-pointer py-1 text-sm font-semibold">Detalhes</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--g-surface-subtle)] p-3 text-xs">{JSON.stringify(row.metadata, null, 2)}</pre></details>
          </div>
        </li>)}</ul>}
    </Card>
    {cursor && <Button type="button" variant="secondary" loading={loading} onClick={() => void load(cursor)}>Carregar mais</Button>}
  </div>;
}

function CorrelationView({ correlation, onClose }: { correlation: AuditCorrelation; onClose: () => void }) {
  const empty = <p className="text-sm text-[var(--g-text-muted)]">Nada registrado.</p>;
  return <Card className="grid gap-5 p-5" aria-label="Correlação">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Correlação</h2><code className="break-all text-xs">{correlation.correlationId}</code></div><Button type="button" size="sm" variant="ghost" onClick={onClose}>Fechar</Button></div>
    <section aria-label="Ações auditadas"><h3 className="text-sm font-semibold">Ações auditadas</h3>{correlation.audit.length === 0 ? empty : <ul className="mt-2 space-y-1 text-sm">{correlation.audit.map((row) => <li key={row.id}>{dateTime.format(new Date(row.createdAt))} · <code>{row.action}</code> · {row.actorName ?? "Sistema"}</li>)}</ul>}</section>
    <div className="grid gap-5 lg:grid-cols-2">
      <section aria-label="Vendas"><h3 className="text-sm font-semibold">Vendas</h3>{correlation.sales.length === 0 ? empty : <ul className="mt-2 space-y-1 text-sm">{correlation.sales.map((row) => <li key={row.id}>{row.channel} · {row.status} · <span className="g-money">{money.format(row.totalCents / 100)}</span> · <code className="text-xs">{row.id}</code></li>)}</ul>}</section>
      <section aria-label="Pagamentos"><h3 className="text-sm font-semibold">Pagamentos</h3>{correlation.payments.length === 0 ? empty : <ul className="mt-2 space-y-1 text-sm">{correlation.payments.map((row) => <li key={row.id}>{row.integrationChannel ?? "—"} · {row.status} · <span className="g-money">{money.format(row.amountCents / 100)}</span></li>)}</ul>}</section>
      <section aria-label="Estoque"><h3 className="text-sm font-semibold">Estoque</h3>{correlation.stockMovements.length === 0 ? empty : <ul className="mt-2 space-y-1 text-sm">{correlation.stockMovements.map((row) => <li key={row.id}>{row.movementType} · {row.items.map((item) => `${item.quantity}× ${item.productName}`).join(", ")}</li>)}</ul>}</section>
      <section aria-label="Financeiro"><h3 className="text-sm font-semibold">Financeiro</h3>{correlation.ledger.length + correlation.cashMovements.length === 0 ? empty : <ul className="mt-2 space-y-1 text-sm">
        {correlation.ledger.map((row) => <li key={row.id}>{row.entryType} · <span className="g-money">{money.format(row.amountCents / 100)}</span></li>)}
        {correlation.cashMovements.map((row) => <li key={row.id}>Caixa {row.movementType} · <span className="g-money">{money.format(row.amountCents / 100)}</span></li>)}
      </ul>}</section>
    </div>
    <section aria-label="Eventos publicados"><h3 className="text-sm font-semibold">Eventos publicados</h3>{correlation.outbox.length === 0 ? empty : <ul className="mt-2 space-y-1 text-sm">{correlation.outbox.map((row, index) => <li key={`${row.topic}-${index}`}><code>{row.topic}</code> · {row.status}</li>)}</ul>}</section>
  </Card>;
}
