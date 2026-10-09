"use client";

import { useCallback, useEffect, useState } from "react";
import { History, X } from "lucide-react";
import { COHORT_HEADER, auditSearchResponseSchema, userCohortMembershipsResponseSchema, type AppRole, type AuditEntry, type UserCohortMembership } from "@germinatura/contracts";
import { Badge, Button, Field, Input } from "@germinatura/ui";

const roleLabels: Record<AppRole, string> = {
  ADMIN: "Administrador", VENDEDOR: "Vendedor", ESTOQUE: "Estoque", FINANCEIRO: "Financeiro",
  COMUNICACAO: "Comunicação", MODERADOR: "Moderador", CONSUMIDOR: "Consumidor",
};
const assignableRoles: AppRole[] = ["ADMIN", "VENDEDOR", "ESTOQUE", "FINANCEIRO", "COMUNICACAO", "MODERADOR"];
const blockerLabels: Record<string, string> = {
  OPEN_SHIFT: "turno de caixa aberto", SELLER_STOCK: "estoque no local do vendedor", PENDING_STOCK_REQUESTS: "transferências ou devoluções pendentes",
  PENDING_SALES: "vendas aguardando pagamento", LAST_COHORT_ADMIN: "último ADMIN ativo da turma",
};
const historyLabels: Record<string, string> = {
  "cohorts.membership.changed": "Vínculo alterado", "auth.user.access.changed": "Papéis ou acesso alterados", "auth.profile.provisioned": "Conta criada na turma",
  "auth.admin_master.granted": "ADMIN_MASTER concedido", "auth.admin_master.revoked": "ADMIN_MASTER revogado",
};
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });

async function readError(response: Response) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? "Não foi possível concluir a operação.";
}

/** Writes go to the chosen cohort explicitly (header), never to "Todas as turmas"; the server validates it again. */
function inCohort(cohortId: string): HeadersInit {
  return { "Content-Type": "application/json", [COHORT_HEADER]: cohortId };
}

/**
 * ADR 0011 (PR 4): ADMIN_MASTER manages which cohorts a person belongs to and the roles in each one. Relational data
 * (user_cohorts + user_roles per cohort); every change has a reason and is audited.
 */
export function MembershipDialog({ user, onClose, onChanged }: { user: { id: string; displayName: string | null; email: string }; onClose: () => void; onChanged: () => void }) {
  const [rows, setRows] = useState<UserCohortMembership[] | null>(null);
  const [history, setHistory] = useState<AuditEntry[]>([]);
  const [reason, setReason] = useState("");
  const [drafts, setDrafts] = useState<Record<string, AppRole[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/v1/admin/users/${user.id}/cohorts`, { cache: "no-store" });
    if (!response.ok) throw new Error(await readError(response));
    const memberships = userCohortMembershipsResponseSchema.parse(await response.json()).data;
    setRows(memberships);
    setDrafts(Object.fromEntries(memberships.map((row) => [row.cohortId, row.roles.filter((role) => role !== "CONSUMIDOR")])));
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 364 * 86_400_000).toISOString().slice(0, 10);
    const audit = await fetch(`/api/v1/admin/audit?from=${from}&to=${to}&entityType=profile&entityId=${user.id}`, { cache: "no-store" });
    if (audit.ok) setHistory(auditSearchResponseSchema.parse(await audit.json()).data.filter((entry) => entry.action in historyLabels));
  }, [user.id]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      load().catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Não foi possível consultar as turmas."); });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [load]);

  async function act(row: UserCohortMembership, kind: "add" | "deactivate" | "reactivate" | "roles") {
    setBusy(`${row.cohortId}:${kind}`); setError(null); setNotice(null);
    try {
      if (kind !== "roles") {
        const membership = await fetch(`/api/v1/admin/users/${user.id}/membership`, { method: "PUT", headers: inCohort(row.cohortId),
          body: JSON.stringify({ active: kind !== "deactivate", reason: reason.trim() }) });
        if (!membership.ok) throw new Error(await readError(membership));
      }
      if (kind === "add" || kind === "roles") {
        const roles = await fetch(`/api/v1/admin/users/${user.id}/roles`, { method: "PATCH", headers: inCohort(row.cohortId),
          body: JSON.stringify({ roles: Array.from(new Set([...(drafts[row.cohortId] ?? []), "CONSUMIDOR"])), active: true }) });
        if (!roles.ok) throw new Error(await readError(roles));
      }
      setNotice({ add: `Adicionada a ${row.name}.`, deactivate: `Vínculo com ${row.name} inativado.`, reactivate: `Vínculo com ${row.name} reativado.`, roles: `Papéis em ${row.name} atualizados.` }[kind]);
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir a operação.");
    } finally { setBusy(null); }
  }

  const reasonValid = reason.trim().length >= 4;
  const cohortName = (id: string | null | undefined) => (id ? rows?.find((row) => row.cohortId === id)?.name ?? "Turma" : "Global");
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-[var(--g-surface-overlay)] sm:items-center sm:p-6">
      <button type="button" className="absolute inset-0" onClick={onClose} aria-label="Fechar janela" />
      <section role="dialog" aria-modal="true" aria-labelledby="membership-dialog-title" className="relative max-h-[100dvh] w-full overflow-y-auto rounded-t-[var(--g-radius-card)] bg-[var(--g-surface-default)] p-6 shadow-[var(--g-shadow-raised)] sm:max-w-3xl sm:rounded-[var(--g-radius-card)]">
        <div className="flex items-start justify-between gap-4">
          <div><h2 id="membership-dialog-title" className="text-xl font-bold">Turmas e papéis</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">{user.displayName ?? user.email} · {user.email}</p></div>
          <button type="button" onClick={onClose} className="flex size-11 shrink-0 items-center justify-center rounded-[var(--g-radius-control)] hover:bg-[var(--g-surface-hover)]" aria-label="Fechar"><X className="size-5" /></button>
        </div>
        <div className="mt-5"><Field id={`membership-reason-${user.id}`} label="Motivo das alterações" description="Obrigatório; fica na auditoria de cada alteração."><Input id={`membership-reason-${user.id}`} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} /></Field></div>
        {notice && <p role="status" className="mt-4 text-sm text-[var(--g-status-success-foreground)]">{notice}</p>}
        {error && <p role="alert" className="mt-4 text-sm text-[var(--g-status-danger-foreground)]">{error}</p>}
        {rows === null ? <p className="mt-6 text-sm">Carregando…</p> : (
          <ul aria-label="Turmas da pessoa" className="mt-6 divide-y divide-[var(--g-border-subtle)] rounded-[var(--g-radius-card)] border border-[var(--g-border-subtle)]">
            {rows.map((row) => {
              const archived = row.status === "ARCHIVED";
              const draft = drafts[row.cohortId] ?? [];
              const changed = row.membership === "ACTIVE" && [...draft].sort().join() !== row.roles.filter((role) => role !== "CONSUMIDOR").sort().join();
              const disabled = archived || busy !== null || !reasonValid;
              return <li key={row.cohortId} aria-label={row.name} className="space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold">{row.name}{archived ? " (arquivada)" : ""}</p>
                  <Badge tone={row.membership === "ACTIVE" ? "success" : row.membership === "INACTIVE" ? "warning" : "info"}>{row.membership === "ACTIVE" ? "Vínculo ativo" : row.membership === "INACTIVE" ? "Vínculo inativo" : "Sem vínculo"}</Badge>
                </div>
                {row.membership !== "NONE" && <p className="text-sm">Papéis nesta turma: {row.roles.length ? row.roles.map((role) => roleLabels[role]).join(", ") : "nenhum"}</p>}
                {!archived && row.membership !== "INACTIVE" && <fieldset><legend className="text-xs font-semibold text-[var(--g-text-muted)]">{row.membership === "NONE" ? "Papéis ao adicionar" : "Papéis"}</legend>
                  <div className="mt-2 flex flex-wrap gap-2">{assignableRoles.map((role) => <label key={role} className="flex min-h-10 items-center gap-2 rounded-[var(--g-radius-control)] border border-[var(--g-border-subtle)] px-3 text-sm">
                    <input type="checkbox" checked={draft.includes(role)} onChange={(event) => setDrafts({ ...drafts, [row.cohortId]: event.target.checked ? [...draft, role] : draft.filter((value) => value !== role) })} className="size-4 accent-[var(--g-brand-primary)]" />{roleLabels[role]}</label>)}</div>
                </fieldset>}
                {row.membership === "ACTIVE" && row.blockers.length > 0 && <p className="text-xs text-[var(--g-status-warning-foreground)]">Não pode ser inativado agora: {row.blockers.map((code) => blockerLabels[code] ?? code).join(", ")}.</p>}
                {archived ? <p className="text-xs text-[var(--g-text-muted)]">Turma arquivada: vínculos e papéis ficam como estão.</p> : <div className="flex flex-wrap gap-2">
                  {row.membership === "NONE" && <Button type="button" size="sm" disabled={disabled} loading={busy === `${row.cohortId}:add`} onClick={() => void act(row, "add")}>Adicionar à turma</Button>}
                  {row.membership === "INACTIVE" && <Button type="button" size="sm" disabled={disabled} loading={busy === `${row.cohortId}:reactivate`} onClick={() => void act(row, "reactivate")}>Reativar vínculo</Button>}
                  {row.membership === "ACTIVE" && <Button type="button" size="sm" variant="secondary" disabled={disabled || !changed} loading={busy === `${row.cohortId}:roles`} onClick={() => void act(row, "roles")}>Salvar papéis</Button>}
                  {row.membership === "ACTIVE" && <Button type="button" size="sm" variant="ghost" disabled={disabled || row.blockers.length > 0} loading={busy === `${row.cohortId}:deactivate`} onClick={() => void act(row, "deactivate")}>Inativar vínculo</Button>}
                </div>}
              </li>;
            })}
          </ul>
        )}
        <section aria-label="Histórico de vínculos" className="mt-6">
          <h3 className="flex items-center gap-2 font-semibold"><History className="size-4" /> Histórico (12 meses)</h3>
          {history.length === 0 ? <p className="mt-2 text-sm text-[var(--g-text-muted)]">Nenhuma alteração registrada.</p> : <ul className="mt-2 space-y-2 text-sm">
            {history.map((entry) => <li key={entry.id} className="flex flex-wrap gap-x-3"><span className="text-[var(--g-text-muted)]">{dateTime.format(new Date(entry.createdAt))}</span><span className="font-semibold">{historyLabels[entry.action]}</span><span>{cohortName(entry.cohortId)}</span>{entry.actorName && <span className="text-[var(--g-text-muted)]">por {entry.actorName}</span>}</li>)}
          </ul>}
        </section>
      </section>
    </div>
  );
}
