"use client";

import { securityEventsResponseSchema, type SecurityEvent, type SecurityEventKind } from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "medium", timeZone: "America/Sao_Paulo" });
const kinds: Record<SecurityEventKind, { label: string; tone: "success" | "warning" | "danger" }> = {
  LOGIN_SUCCEEDED: { label: "Login", tone: "success" }, LOGIN_FAILED: { label: "Login recusado", tone: "warning" },
  LOGIN_RATE_LIMITED: { label: "Login bloqueado por tentativas", tone: "danger" }, AUTHORIZATION_DENIED: { label: "Acesso negado", tone: "danger" },
};
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
function shift(day: string, days: number) { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }

/** AUD-001 (spec 5.16): logins, failed logins and authorization denials — no passwords, tokens or IPs. */
export function SecurityEventsView() {
  const [filters, setFilters] = useState({ from: shift(today(), -6), to: today(), kind: "", actor: "" });
  const [applied, setApplied] = useState(filters);
  const [rows, setRows] = useState<SecurityEvent[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (after?: { createdAt: string; id: string }) => {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ from: applied.from, to: applied.to });
      if (applied.kind) params.set("kind", applied.kind);
      if (applied.actor.trim()) params.set("actor", applied.actor.trim());
      if (after) { params.set("cursorCreatedAt", after.createdAt); params.set("cursorId", after.id); }
      const response = await fetch(`/api/v1/admin/audit/security?${params}`, { cache: "no-store" });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error((body as { message?: string } | null)?.message ?? "Não foi possível consultar os eventos de segurança.");
      const parsed = securityEventsResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error("Os eventos de segurança retornaram dados inválidos.");
      setRows((current) => after ? [...current, ...parsed.data.data] : parsed.data.data);
      setCursor(parsed.data.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível consultar os eventos de segurança."); }
    finally { setLoading(false); }
  }, [applied]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  return <div className="grid gap-6">
    <Card className="p-5">
      <form aria-label="Filtrar eventos de segurança" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end" onSubmit={(event) => { event.preventDefault(); setApplied(filters); }}>
        <Field id="security-from" label="De"><Input id="security-from" type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></Field>
        <Field id="security-to" label="Até"><Input id="security-to" type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></Field>
        <Field id="security-kind" label="Evento"><select id="security-kind" className="g-input min-h-11 w-full" value={filters.kind} onChange={(event) => setFilters({ ...filters, kind: event.target.value })}><option value="">Todos</option>{Object.entries(kinds).map(([value, { label }]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        <Field id="security-actor" label="Usuário ou identificador"><Input id="security-actor" value={filters.actor} maxLength={80} onChange={(event) => setFilters({ ...filters, actor: event.target.value })} /></Field>
        <div className="sm:col-span-2 lg:col-span-4"><Button type="submit" variant="brand" disabled={loading}><Search className="size-4" />Pesquisar</Button></div>
      </form>
      <p className="mt-3 text-xs text-[var(--g-text-muted)]">Tentativas com identificadores sem cadastro aparecem sem nome; digite o identificador exato para encontrá-las.</p>
    </Card>
    {error && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 p-4 text-sm"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--g-status-danger)]" /><p>{error}</p></div>}
    <Card className="overflow-hidden">
      {loading && rows.length === 0 ? <p role="status" className="p-5 text-sm">Consultando…</p>
        : rows.length === 0 ? <p className="p-5 text-sm text-[var(--g-text-secondary)]">Nenhum evento com esses filtros.</p>
        : <ul aria-label="Eventos de segurança" className="divide-y divide-[var(--g-border-subtle)]">{rows.map((row) => <li key={row.id} aria-label={`${kinds[row.kind].label} de ${row.actorName ?? "identificador sem cadastro"}`} className="p-4 text-sm">
          <div className="flex flex-wrap items-center gap-2"><Badge tone={kinds[row.kind].tone}>{kinds[row.kind].label}</Badge><span className="font-semibold">{row.actorName ?? `Sem cadastro (${row.subjectHashPrefix ?? "—"})`}</span><span className="text-[var(--g-text-muted)]">{dateTime.format(new Date(row.createdAt))} · {row.app === "PDV" ? "PDV" : "Portal"}</span></div>
          {row.route && <p className="mt-1 text-[var(--g-text-secondary)]"><code>{row.method} {row.route}</code></p>}
          {row.requestId && <p className="mt-1 text-xs text-[var(--g-text-muted)]">Requisição {row.requestId}</p>}
        </li>)}</ul>}
    </Card>
    {cursor && <Button type="button" variant="secondary" loading={loading} onClick={() => void load(cursor)}>Carregar mais</Button>}
  </div>;
}
