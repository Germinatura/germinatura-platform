"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, GraduationCap, Pencil, Plus, X } from "lucide-react";
import { cohortOverviewResponseSchema, type CohortOverview, type CohortStatus, type CohortSummary } from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";

const statusLabels: Record<CohortStatus, string> = { PREPARING: "Em preparação", ACTIVE: "Ativa", ARCHIVED: "Arquivada" };
const statusTones: Record<CohortStatus, "info" | "success" | "warning"> = { PREPARING: "info", ACTIVE: "success", ARCHIVED: "warning" };
const roleLabels: Record<string, string> = { ADMIN: "Administração", VENDEDOR: "Vendas", ESTOQUE: "Estoque", FINANCEIRO: "Financeiro", COMUNICACAO: "Comunicação", MODERADOR: "Moderação", CONSUMIDOR: "Consumidores" };
const operationLabels: Record<string, string> = {
  OPEN_SHIFTS: "turnos de caixa abertos", PENDING_SALES: "vendas aguardando pagamento", PENDING_PAYMENTS: "pagamentos em andamento",
  OPEN_PAYMENT_LINKS: "links de pagamento ativos", OPEN_RESERVATIONS: "reservas em aberto", ACTIVE_STOCK_RESERVATIONS: "estoque reservado",
  PENDING_STOCK_REQUESTS: "transferências ou devoluções pendentes", PENDING_APPROVALS: "contagens ou perdas aguardando aprovação",
  OPEN_RAFFLES: "rifas ativas ou pausadas",
};
const selectClass = "mt-1 block min-h-11 w-full rounded-[var(--g-radius-control)] border border-[var(--g-border-default)] bg-[var(--g-surface-default)] px-3";

async function readError(response: Response) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? "Não foi possível concluir a operação.";
}

/**
 * ADR 0011: ADMIN_MASTER creates, renames, archives and reactivates cohorts. These are global operations, so they work
 * in "Todas as turmas"; an archived cohort stays readable and refuses new writes, and the default cohort is never archived.
 */
export function CohortsManager({ initial, unavailable = false }: { initial: CohortOverview[]; unavailable?: boolean }) {
  const router = useRouter();
  const [cohorts, setCohorts] = useState(initial);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CohortSummary | null>(null);

  async function completed(message: string) {
    setNotice(message); setCreating(false); setEditing(null);
    const response = await fetch("/api/v1/admin/cohorts", { cache: "no-store" });
    if (response.ok) setCohorts(cohortOverviewResponseSchema.parse(await response.json()).data);
    router.refresh(); // the cohort selector lists the new state
  }

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div><p className="text-sm font-semibold text-[var(--g-brand-primary)]">ADMIN_MASTER</p><h1 className="mt-1 text-3xl font-bold tracking-tight">Turmas</h1><p className="mt-2 max-w-2xl text-base text-[var(--g-text-secondary)]">Cada turma tem seus próprios usuários, papéis, catálogo, estoque, vendas e livros financeiros.</p></div>
          <Button type="button" onClick={() => { setNotice(null); setCreating(true); }}><Plus className="size-5" /> Nova turma</Button>
        </header>
        {unavailable && <div role="alert" className="rounded-[var(--g-radius-control)] bg-[var(--g-status-danger-soft)] p-4 text-sm text-[var(--g-status-danger-foreground)]">Não foi possível carregar as contagens das turmas. Recarregue a página.</div>}
        {notice && <div role="status" className="flex items-center gap-3 rounded-[var(--g-radius-control)] bg-[var(--g-status-success-soft)] p-4 text-sm text-[var(--g-status-success-foreground)]"><Check className="size-5" />{notice}</div>}
        <Card className="overflow-hidden">
          <ul className="divide-y divide-[var(--g-border-subtle)]" aria-label="Turmas">
            {cohorts.map((cohort) => <li key={cohort.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3"><GraduationCap className="mt-0.5 size-5 text-[var(--g-text-muted)]" /><div>
                <p className="font-semibold">{cohort.name}</p><p className="mt-1 text-xs text-[var(--g-text-muted)]">{cohort.year} · {cohort.slug}</p>
                <p className="mt-2 text-sm">{cohort.membersActive} {cohort.membersActive === 1 ? "vínculo ativo" : "vínculos ativos"} · {cohort.membersInactive} {cohort.membersInactive === 1 ? "inativo" : "inativos"}</p>
                {Object.keys(cohort.roles).length > 0 && <p className="mt-1 text-xs text-[var(--g-text-secondary)]">{Object.entries(cohort.roles).filter(([key]) => key !== "CONSUMIDOR").map(([key, count]) => `${roleLabels[key] ?? key}: ${count}`).join(" · ") || "Sem papéis operacionais"}</p>}
                {cohort.openOperations.length > 0 && <p className="mt-1 text-xs text-[var(--g-status-warning-foreground)]">Em aberto: {cohort.openOperations.map((code) => operationLabels[code] ?? code).join(", ")}</p>}
              </div></div>
              <div className="flex flex-wrap items-center gap-2"><Badge tone={statusTones[cohort.status]}>{statusLabels[cohort.status]}</Badge>{cohort.isDefault && <Badge tone="info">Padrão</Badge>}
                <Button type="button" variant="ghost" size="sm" onClick={() => { setNotice(null); setEditing(cohort); }} aria-label={`Alterar ${cohort.name}`}><Pencil className="size-4" /> Alterar</Button></div>
            </li>)}
          </ul>
        </Card>
      </div>
      {creating && <CreateCohortDialog onClose={() => setCreating(false)} onComplete={(name) => void completed(`Turma ${name} criada.`)} />}
      {editing && <EditCohortDialog cohort={editing} openOperations={cohorts.find((item) => item.id === editing.id)?.openOperations ?? []} onClose={() => setEditing(null)} onComplete={(name) => void completed(`Turma ${name} atualizada.`)} />}
    </div>
  );
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="fixed inset-0 z-[70] flex items-end justify-center bg-[var(--g-surface-overlay)] sm:items-center sm:p-6"><button type="button" className="absolute inset-0" onClick={onClose} aria-label="Fechar janela" /><section role="dialog" aria-modal="true" aria-labelledby="cohort-dialog-title" className="relative max-h-[100dvh] w-full overflow-y-auto rounded-t-[var(--g-radius-card)] bg-[var(--g-surface-default)] p-6 shadow-[var(--g-shadow-raised)] sm:max-w-lg sm:rounded-[var(--g-radius-card)]"><div className="flex items-start justify-between gap-4"><h2 id="cohort-dialog-title" className="text-xl font-bold">{title}</h2><button type="button" onClick={onClose} className="flex size-11 shrink-0 items-center justify-center rounded-[var(--g-radius-control)] hover:bg-[var(--g-surface-hover)]" aria-label="Fechar"><X className="size-5" /></button></div>{children}</section></div>;
}

function CreateCohortDialog({ onClose, onComplete }: { onClose: () => void; onComplete: (name: string) => void }) {
  const [form, setForm] = useState({ name: "", year: String(new Date().getFullYear() + 1), slug: "", status: "PREPARING" as "PREPARING" | "ACTIVE" });
  const [key] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      const response = await fetch("/api/v1/admin/cohorts", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ name: form.name.trim(), year: Number(form.year), slug: form.slug.trim(), status: form.status }) });
      if (!response.ok) throw new Error(await readError(response));
      onComplete(form.name.trim());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível criar a turma."); } finally { setSaving(false); }
  }
  return <Dialog title="Nova turma" onClose={onClose}><form onSubmit={submit} className="mt-6 space-y-4">
    <Field id="cohort-name" label="Nome"><Input id="cohort-name" required minLength={3} maxLength={80} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id="cohort-year" label="Ano"><Input id="cohort-year" required type="number" min={2000} max={2100} value={form.year} onChange={(event) => setForm({ ...form, year: event.target.value })} /></Field>
      <Field id="cohort-slug" label="Identificador" description="Letras minúsculas, números e hífen."><Input id="cohort-slug" required maxLength={60} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value.toLowerCase() })} /></Field>
    </div>
    <label className="block text-sm font-semibold">Situação inicial<select className={selectClass} value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as "PREPARING" | "ACTIVE" })}><option value="PREPARING">Em preparação</option><option value="ACTIVE">Ativa</option></select></label>
    {error && <p role="alert" className="text-sm text-[var(--g-status-danger-foreground)]">{error}</p>}
    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"><Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" loading={saving}>Criar turma</Button></div>
  </form></Dialog>;
}

function EditCohortDialog({ cohort, openOperations, onClose, onComplete }: { cohort: CohortSummary; openOperations: string[]; onClose: () => void; onComplete: (name: string) => void }) {
  const [name, setName] = useState(cohort.name); const [status, setStatus] = useState<CohortStatus>(cohort.status); const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      const response = await fetch(`/api/v1/admin/cohorts/${cohort.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), status, reason: reason.trim() }) });
      if (!response.ok) throw new Error(await readError(response));
      onComplete(name.trim());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível alterar a turma."); } finally { setSaving(false); }
  }
  return <Dialog title={`Alterar ${cohort.name}`} onClose={onClose}><form onSubmit={submit} className="mt-6 space-y-4">
    <Field id="cohort-edit-name" label="Nome"><Input id="cohort-edit-name" required minLength={3} maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></Field>
    <label className="block text-sm font-semibold">Situação<select className={selectClass} value={status} onChange={(event) => setStatus(event.target.value as CohortStatus)}>
      <option value="PREPARING">Em preparação</option><option value="ACTIVE">Ativa</option>{!cohort.isDefault && <option value="ARCHIVED">Arquivada</option>}
    </select></label>
    {status === "ARCHIVED" && cohort.status !== "ARCHIVED" && <p className="text-sm text-[var(--g-text-secondary)]">Arquivar mantém todo o histórico consultável e bloqueia novas vendas, estoque e lançamentos nesta turma.</p>}
    {status === "ARCHIVED" && cohort.status !== "ARCHIVED" && openOperations.length > 0 && <p role="alert" className="text-sm text-[var(--g-status-danger-foreground)]">Ainda não é possível arquivar: {openOperations.map((code) => operationLabels[code] ?? code).join(", ")}. Encerre essas operações na turma primeiro.</p>}
    <Field id="cohort-edit-reason" label="Motivo"><Input id="cohort-edit-reason" required minLength={4} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
    {error && <p role="alert" className="text-sm text-[var(--g-status-danger-foreground)]">{error}</p>}
    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"><Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" loading={saving} disabled={reason.trim().length < 4}>Salvar</Button></div>
  </form></Dialog>;
}
