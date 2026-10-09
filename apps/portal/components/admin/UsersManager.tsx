"use client";

import { useEffect, useState } from "react";
import { Check, Crown, GraduationCap, Pencil, Plus, Search, UserRoundCog, X } from "lucide-react";
import { MembershipDialog } from "@/components/admin/MembershipDialog";
import { adminUsersResponseSchema, type AdminProvisionUser, type AdminUser, type AppRole, type CohortMode, type CohortSummary } from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input, InputGroup } from "@germinatura/ui";

const roleLabels: Record<AppRole, string> = {
  ADMIN: "Administrador", VENDEDOR: "Vendedor", ESTOQUE: "Estoque", FINANCEIRO: "Financeiro",
  COMUNICACAO: "Comunicação", MODERADOR: "Moderador", CONSUMIDOR: "Consumidor",
};
const provisionableRoles: AppRole[] = ["VENDEDOR", "ESTOQUE", "FINANCEIRO", "COMUNICACAO", "MODERADOR", "CONSUMIDOR"];
const editableRoles: AppRole[] = ["ADMIN", ...provisionableRoles];
const initialCreate: AdminProvisionUser = { email: "", displayName: "", username: "", password: "", roles: ["VENDEDOR"], active: true };

async function readError(response: Response) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? "Não foi possível concluir a operação.";
}

const PAGE_SIZE = 25;
type StatusFilter = "ALL" | "ACTIVE" | "INACTIVE";
type OnboardingFilter = "ALL" | "COMPLETE" | "INCOMPLETE";
interface Filters { q: string; status: StatusFilter; onboarding: OnboardingFilter; roles: AppRole[]; roleMatch: "ANY" | "ALL"; cohort: string }
const emptyFilters: Filters = { q: "", status: "ALL", onboarding: "ALL", roles: [], roleMatch: "ANY", cohort: "" };
type ListedUser = AdminUser & { cohorts?: { id: string; name: string; active: boolean; roles: AppRole[] }[]; adminMaster?: boolean };
const selectClass = "mt-1 block min-h-11 w-full rounded-[var(--g-radius-control)] border border-[var(--g-border-default)] bg-[var(--g-surface-default)] px-3";

function searchParams(filters: Filters, offset: number) {
  const params = new URLSearchParams({ status: filters.status, onboarding: filters.onboarding, roleMatch: filters.roleMatch, offset: String(offset), limit: String(PAGE_SIZE) });
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.roles.length > 0) params.set("roles", filters.roles.join(","));
  if (filters.cohort) params.set("cohort", filters.cohort);
  return params;
}

/**
 * ADR 0011 (PR 3): the people of the cohort in context, filtered and paginated by the server. ADMIN_MASTER in "all"
 * sees every cohort and may filter by one; a cohort admin sees and changes only the people and roles of the cohort.
 */
export function UsersManager({ cohortMode, cohorts, canFilterCohort, isMaster = false }: { cohortMode: CohortMode; cohorts: CohortSummary[]; canFilterCohort: boolean; isMaster?: boolean }) {
  const [users, setUsers] = useState<ListedUser[]>([]);
  const [page, setPage] = useState({ total: 0, matched: 0, offset: 0 });
  // The outcome of the last finished request; anything else in flight shows as loading.
  const [outcome, setOutcome] = useState<{ key: string; error: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ListedUser | null>(null);
  const [mastering, setMastering] = useState<ListedUser | null>(null);
  const [memberships, setMemberships] = useState<ListedUser | null>(null);
  const readOnly = cohortMode !== "COHORT";

  // The search box applies after a short pause; every filter change goes back to the first page.
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((current) => (current.q === search ? current : { ...current, q: search }));
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = searchParams(filters, offset).toString();
  const requestKey = `${query}#${reload}`;
  const loading = outcome?.key !== requestKey;
  const error = loading ? null : outcome.error;
  useEffect(() => {
    let active = true;
    fetch(`/api/v1/admin/users?${query}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readError(response));
        return adminUsersResponseSchema.parse(await response.json());
      })
      .then((body) => { if (active) { setUsers(body.data); setPage(body.page); setOutcome({ key: requestKey, error: null }); } })
      .catch((cause: unknown) => { if (active) setOutcome({ key: requestKey, error: cause instanceof Error ? cause.message : "Não foi possível consultar os usuários." }); });
    return () => { active = false; };
  }, [query, requestKey]);

  function update(next: Partial<Filters>) { setFilters((current) => ({ ...current, ...next })); setOffset(0); }
  function clearAll() { setSearch(""); setFilters(emptyFilters); setOffset(0); }
  function completed(message: string) { setNotice(message); setCreateOpen(false); setEditing(null); setMastering(null); setReload((value) => value + 1); }

  const chips: { key: string; label: string; clear: () => void }[] = [];
  if (filters.q) chips.push({ key: "q", label: `Busca: ${filters.q}`, clear: () => { setSearch(""); update({ q: "" }); } });
  if (filters.status !== "ALL") chips.push({ key: "status", label: filters.status === "ACTIVE" ? "Ativos" : "Inativos", clear: () => update({ status: "ALL" }) });
  if (filters.onboarding !== "ALL") chips.push({ key: "onboarding", label: filters.onboarding === "COMPLETE" ? "Cadastro completo" : "Cadastro incompleto", clear: () => update({ onboarding: "ALL" }) });
  for (const role of filters.roles) chips.push({ key: `role-${role}`, label: `${filters.roleMatch === "ALL" ? "Todos" : "Qualquer"}: ${roleLabels[role]}`, clear: () => update({ roles: filters.roles.filter((value) => value !== role) }) });
  if (filters.cohort) chips.push({ key: "cohort", label: `Turma: ${cohorts.find((cohort) => cohort.id === filters.cohort)?.name ?? "selecionada"}`, clear: () => update({ cohort: "" }) });

  const lastShown = Math.min(page.offset + users.length, page.matched);
  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div><p className="text-sm font-semibold text-[var(--g-brand-primary)]">Gestão de acesso</p><h1 className="mt-1 text-3xl font-bold tracking-tight">Usuários e vendedores</h1><p className="mt-2 max-w-2xl text-base text-[var(--g-text-secondary)]">{readOnly ? "Visão consolidada de todas as turmas. Selecione uma turma para criar contas ou alterar papéis." : "Crie contas operacionais, atribua papéis da turma e revogue acessos imediatamente."}</p></div>
          <Button type="button" disabled={readOnly} onClick={() => { setNotice(null); setCreateOpen(true); }}><Plus className="size-5" /> Adicionar usuário</Button>
        </header>

        {notice && <div role="status" className="flex items-center gap-3 rounded-[var(--g-radius-control)] bg-[var(--g-status-success-soft)] p-4 text-sm text-[var(--g-status-success-foreground)]"><Check className="size-5" />{notice}</div>}
        {error && <div role="alert" className="rounded-[var(--g-radius-control)] bg-[var(--g-status-danger-soft)] p-4 text-sm text-[var(--g-status-danger-foreground)]"><p>{error}</p><button type="button" onClick={() => setReload((value) => value + 1)} className="mt-2 min-h-11 font-semibold underline">Tentar novamente</button></div>}

        <Card className="overflow-hidden">
          <div className="space-y-4 border-b border-[var(--g-border-subtle)] p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div><h2 className="text-lg font-bold">Contas cadastradas</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]" aria-live="polite">{loading ? "Consultando…" : `${page.matched} de ${page.total} usuários`}</p></div>
              <label className="block w-full min-w-0 sm:max-w-sm"><span className="sr-only">Buscar usuários</span><InputGroup icon={<Search />}><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nome, usuário ou e-mail" /></InputGroup></label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="text-sm font-semibold">Situação<select className={selectClass} value={filters.status} onChange={(event) => update({ status: event.target.value as StatusFilter })}><option value="ALL">Todos</option><option value="ACTIVE">Ativos</option><option value="INACTIVE">Inativos</option></select></label>
              <label className="text-sm font-semibold">Cadastro<select className={selectClass} value={filters.onboarding} onChange={(event) => update({ onboarding: event.target.value as OnboardingFilter })}><option value="ALL">Todos</option><option value="COMPLETE">Completo</option><option value="INCOMPLETE">Incompleto</option></select></label>
              <label className="text-sm font-semibold">Papéis combinados por<select className={selectClass} value={filters.roleMatch} onChange={(event) => update({ roleMatch: event.target.value as "ANY" | "ALL" })}><option value="ANY">Qualquer papel</option><option value="ALL">Todos os papéis</option></select></label>
              {canFilterCohort && <label className="text-sm font-semibold">Turma<select aria-label="Turma" className={selectClass} value={filters.cohort} onChange={(event) => update({ cohort: event.target.value })}><option value="">Todas as turmas</option>{cohorts.map((cohort) => <option key={cohort.id} value={cohort.id}>{cohort.name}</option>)}</select></label>}
            </div>
            <fieldset><legend className="text-sm font-semibold">Papéis</legend><div className="mt-2 flex flex-wrap gap-2">{editableRoles.map((role) => <label key={role} className="flex min-h-11 items-center gap-2 rounded-[var(--g-radius-control)] border border-[var(--g-border-subtle)] px-3 text-sm"><input type="checkbox" checked={filters.roles.includes(role)} onChange={(event) => update({ roles: event.target.checked ? [...filters.roles, role] : filters.roles.filter((value) => value !== role) })} className="size-4 accent-[var(--g-brand-primary)]" />{roleLabels[role]}</label>)}</div></fieldset>
            {chips.length > 0 && <div className="flex flex-wrap items-center gap-2" aria-label="Filtros ativos">{chips.map((chip) => <button key={chip.key} type="button" onClick={chip.clear} className="flex min-h-9 items-center gap-1 rounded-full bg-[var(--g-surface-subtle)] px-3 text-sm" aria-label={`Remover filtro ${chip.label}`}>{chip.label}<X className="size-4" /></button>)}<Button type="button" variant="ghost" size="sm" onClick={clearAll}>Limpar filtros</Button></div>}
          </div>
          {loading ? <UsersSkeleton /> : !error && users.length === 0 ? <div className="p-10 text-center"><UserRoundCog className="mx-auto size-10 text-[var(--g-text-muted)]" /><p className="mt-4 font-semibold">Nenhum usuário encontrado</p><p className="mt-1 text-sm text-[var(--g-text-secondary)]">Ajuste os filtros ou adicione uma nova conta operacional.</p></div> : !error && <UsersList users={users} onEdit={readOnly ? undefined : setEditing} onMaster={isMaster ? setMastering : undefined} onMemberships={isMaster ? setMemberships : undefined} />}
          {!loading && page.matched > PAGE_SIZE && <nav aria-label="Paginação de usuários" className="flex items-center justify-between gap-3 border-t border-[var(--g-border-subtle)] p-4 text-sm"><span>{page.offset + 1}–{lastShown} de {page.matched}</span><div className="flex gap-2"><Button type="button" variant="secondary" size="sm" disabled={page.offset === 0} onClick={() => setOffset(Math.max(0, page.offset - PAGE_SIZE))}>Anterior</Button><Button type="button" variant="secondary" size="sm" disabled={lastShown >= page.matched} onClick={() => setOffset(page.offset + PAGE_SIZE)}>Próxima</Button></div></nav>}
        </Card>
      </div>
      {createOpen && <CreateUserDialog onClose={() => setCreateOpen(false)} onComplete={() => completed("Conta criada e acesso configurado.")} />}
      {editing && <EditAccessDialog user={editing} onClose={() => setEditing(null)} onComplete={(message) => completed(message ?? "Papéis e estado de acesso atualizados.")} />}
      {memberships && <MembershipDialog user={memberships} onClose={() => setMemberships(null)} onChanged={() => setReload((value) => value + 1)} />}
      {mastering && <AdminMasterDialog user={mastering} onClose={() => setMastering(null)} onComplete={() => completed(mastering.adminMaster ? "ADMIN_MASTER revogado." : "ADMIN_MASTER concedido.")} />}
    </div>
  );
}

function UsersList({ users, onEdit, onMaster, onMemberships }: { users: ListedUser[]; onEdit?: (user: ListedUser) => void; onMaster?: (user: ListedUser) => void; onMemberships?: (user: ListedUser) => void }) {
  return <>
    <div className="hidden overflow-x-auto md:block"><table className="w-full text-left text-sm"><thead className="bg-[var(--g-surface-subtle)] text-xs uppercase tracking-wide text-[var(--g-text-muted)]"><tr><th className="px-6 py-3 font-semibold">Pessoa</th><th className="px-6 py-3 font-semibold">Papéis</th><th className="px-6 py-3 font-semibold">Estado</th><th className="px-6 py-3 text-right font-semibold">Ações</th></tr></thead><tbody className="divide-y divide-[var(--g-border-subtle)]">{users.map((user) => <tr key={user.id} className="hover:bg-[var(--g-surface-hover)]"><td className="px-6 py-4"><p className="font-semibold">{user.displayName ?? user.email}</p><p className="mt-1 text-xs text-[var(--g-text-muted)]">@{user.username ?? "cadastro-incompleto"} · {user.email}</p></td><td className="px-6 py-4">{user.cohorts ? <CohortRoles cohorts={user.cohorts} /> : <div className="flex max-w-md flex-wrap gap-1">{user.roles.map((role) => <Badge key={role} tone="info">{roleLabels[role]}</Badge>)}</div>}</td><td className="px-6 py-4"><Badge tone={user.active ? "success" : "danger"}>{user.active ? "Ativo" : "Inativo"}</Badge>{!user.onboardingCompleted && <Badge tone="warning" className="ml-1">Cadastro incompleto</Badge>}<LockBadges user={user} />{user.adminMaster && <Badge tone="info" className="ml-1">ADMIN_MASTER</Badge>}</td><td className="px-6 py-4 text-right">{onMemberships && <Button variant="ghost" size="sm" onClick={() => onMemberships(user)} aria-label={`Turmas de ${user.displayName ?? user.email}`}><GraduationCap className="size-4" /> Turmas</Button>}{onMaster && <Button variant="ghost" size="sm" onClick={() => onMaster(user)} aria-label={`ADMIN_MASTER de ${user.displayName ?? user.email}`}><Crown className="size-4" /> Master</Button>}{onEdit && <Button variant="ghost" size="sm" onClick={() => onEdit(user)} aria-label={`Editar acesso de ${user.displayName ?? user.email}`}><Pencil className="size-4" /> Editar</Button>}</td></tr>)}</tbody></table></div>
    <div className="divide-y divide-[var(--g-border-subtle)] md:hidden">{users.map((user) => <article key={user.id} className="space-y-4 p-5"><div><p className="font-semibold">{user.displayName ?? user.email}</p><p className="mt-1 break-all text-sm text-[var(--g-text-muted)]">{user.email}</p></div>{user.cohorts ? <CohortRoles cohorts={user.cohorts} /> : <div className="flex flex-wrap gap-1">{user.roles.map((role) => <Badge key={role} tone="info">{roleLabels[role]}</Badge>)}</div>}<div className="flex items-center justify-between gap-3"><div className="flex flex-wrap gap-1"><Badge tone={user.active ? "success" : "danger"}>{user.active ? "Ativo" : "Inativo"}</Badge><LockBadges user={user} />{user.adminMaster && <Badge tone="info">ADMIN_MASTER</Badge>}</div><div className="flex flex-wrap justify-end gap-2">{onMemberships && <Button variant="secondary" size="sm" onClick={() => onMemberships(user)}><GraduationCap className="size-4" /> Turmas</Button>}{onMaster && <Button variant="secondary" size="sm" onClick={() => onMaster(user)}><Crown className="size-4" /> Master</Button>}{onEdit && <Button variant="secondary" size="sm" onClick={() => onEdit(user)}><Pencil className="size-4" /> Editar acesso</Button>}</div></div></article>)}</div>
  </>;
}

/** ADMIN_MASTER: the roles of each cohort, never merged (a role belongs to one cohort). */
function CohortRoles({ cohorts }: { cohorts: NonNullable<ListedUser["cohorts"]> }) {
  return <ul className="space-y-1">{cohorts.map((cohort) => <li key={cohort.id} className="flex flex-wrap items-center gap-1"><span className="text-xs font-semibold">{cohort.name}{cohort.active ? "" : " (inativo)"}:</span>{cohort.roles.map((role) => <Badge key={role} tone="info">{roleLabels[role]}</Badge>)}</li>)}</ul>;
}

function DialogFrame({ title, description, onClose, children }: { title: string; description: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="fixed inset-0 z-[70] flex items-end justify-center bg-[var(--g-surface-overlay)] p-0 sm:items-center sm:p-6"><button type="button" className="absolute inset-0" onClick={onClose} aria-label="Fechar janela" /><section role="dialog" aria-modal="true" aria-labelledby="access-dialog-title" className="relative max-h-[100dvh] w-full overflow-y-auto rounded-t-[var(--g-radius-card)] bg-[var(--g-surface-default)] p-6 shadow-[var(--g-shadow-raised)] sm:max-w-2xl sm:rounded-[var(--g-radius-card)]"><div className="flex items-start justify-between gap-4"><div><h2 id="access-dialog-title" className="text-xl font-bold">{title}</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">{description}</p></div><button type="button" onClick={onClose} className="flex size-11 shrink-0 items-center justify-center rounded-[var(--g-radius-control)] hover:bg-[var(--g-surface-hover)]" aria-label="Fechar"><X className="size-5" /></button></div>{children}</section></div>;
}

function RoleOptions({ roles, setRoles, options }: { roles: AppRole[]; setRoles: (roles: AppRole[]) => void; options: AppRole[] }) {
  return <fieldset><legend className="text-sm font-semibold">Papéis e permissões</legend><p className="mt-1 text-xs text-[var(--g-text-muted)]">Os papéis são cumulativos. Consumidor é mantido em todas as contas.</p><div className="mt-3 grid gap-2 sm:grid-cols-2">{options.map((role) => { const checked = roles.includes(role) || role === "CONSUMIDOR"; return <label key={role} className="flex min-h-11 items-center gap-3 rounded-[var(--g-radius-control)] border border-[var(--g-border-subtle)] px-3 text-sm"><input type="checkbox" checked={checked} disabled={role === "CONSUMIDOR"} onChange={(event) => setRoles(event.target.checked ? [...roles, role] : roles.filter((value) => value !== role))} className="size-4 accent-[var(--g-brand-primary)]" />{roleLabels[role]}</label>; })}</div></fieldset>;
}

function CreateUserDialog({ onClose, onComplete }: { onClose: () => void; onComplete: () => void }) {
  const [form, setForm] = useState(initialCreate); const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) { event.preventDefault(); setSaving(true); setError(null); try { const response = await fetch("/api/v1/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, roles: form.roles.filter((role) => role !== "CONSUMIDOR") }) }); if (!response.ok) throw new Error(await readError(response)); setForm(initialCreate); onComplete(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível criar a conta."); } finally { setSaving(false); } }
  return <DialogFrame title="Adicionar usuário" description="Crie uma conta institucional já verificada para a operação." onClose={onClose}><form onSubmit={submit} className="mt-6 space-y-5"><div className="grid gap-4 sm:grid-cols-2"><Field id="display-name" label="Nome completo"><Input id="display-name" required minLength={2} maxLength={120} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></Field><Field id="username" label="Nome de usuário" description="Comece com letra; use letras minúsculas, números, ponto ou sublinhado."><Input id="username" required minLength={3} maxLength={32} autoCapitalize="none" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} /></Field><Field id="email" label="E-mail institucional"><Input id="email" required type="email" autoComplete="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field><Field id="temporary-password" label="Senha temporária" description="Mínimo de 8 caracteres, com maiúscula, minúscula e número."><Input id="temporary-password" required type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field></div><RoleOptions roles={[...form.roles, "CONSUMIDOR"]} setRoles={(roles) => setForm({ ...form, roles: roles.filter((role) => role !== "ADMIN") })} options={provisionableRoles} /><label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} className="size-4 accent-[var(--g-brand-primary)]" />Liberar acesso imediatamente</label>{error && <p role="alert" className="text-sm text-[var(--g-status-danger-foreground)]">{error}</p>}<div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"><Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" loading={saving}>Criar conta</Button></div></form></DialogFrame>;
}

const pendingLabels: Record<string, string> = {
  OPEN_SHIFT: "turno de caixa aberto (Financeiro › Turnos: encerrar pelo vendedor)",
  SELLER_STOCK: "estoque no local do vendedor (Estoque: transferir para o central)",
  PENDING_STOCK_REQUESTS: "transferências ou devoluções pendentes (Estoque: decidir os pedidos)",
  PENDING_SALES: "vendas aguardando pagamento (Financeiro › Vendas: cancelar ou concluir)",
};

/** ADR 0011 (PR 5): revoking access is immediate; what remains open is named for another ADMIN to take over. */
function revocationMessage(pending: string[]): string {
  if (pending.length === 0) return "Papéis e estado de acesso atualizados.";
  return `Acesso revogado. Pendências que permanecem nesta turma, sem nenhuma alteração: ${pending.map((code) => pendingLabels[code] ?? code).join("; ")}.`;
}

function EditAccessDialog({ user, onClose, onComplete }: { user: AdminUser; onClose: () => void; onComplete: (message?: string) => void }) {
  const [roles, setRoles] = useState<AppRole[]>(user.roles); const [active, setActive] = useState(user.active); const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) { event.preventDefault(); setSaving(true); setError(null); try { const response = await fetch(`/api/v1/admin/users/${user.id}/roles`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roles: Array.from(new Set([...roles, "CONSUMIDOR"])), active }) }); if (!response.ok) throw new Error(await readError(response)); const saved = await response.json().catch(() => null) as { data?: { pending_operations?: unknown } } | null; const pending = Array.isArray(saved?.data?.pending_operations) ? saved.data.pending_operations.filter((code): code is string => typeof code === "string") : []; onComplete(active ? undefined : revocationMessage(pending)); } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível atualizar o acesso."); } finally { setSaving(false); } }
  return <DialogFrame title="Editar acesso" description={`${user.displayName ?? user.email} · ${user.email}`} onClose={onClose}><form onSubmit={submit} className="mt-6 space-y-5"><RoleOptions roles={roles} setRoles={setRoles} options={editableRoles} /><label className="flex min-h-11 items-center gap-3 rounded-[var(--g-radius-control)] border border-[var(--g-border-subtle)] px-3 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-4 accent-[var(--g-brand-primary)]" /><span><strong className="block">Conta ativa</strong><span className="text-xs text-[var(--g-text-muted)]">Desmarcar revoga o acesso ao Portal e ao PDV imediatamente.</span></span></label>{error && <p role="alert" className="text-sm text-[var(--g-status-danger-foreground)]">{error}</p>}<div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"><Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" loading={saving}>Salvar alterações</Button></div></form>{(user.locks?.passwordRecovery || user.locks?.signupCode) && <UnlockSection user={user} onComplete={onComplete} />}</DialogFrame>;
}

/** ADR 0011: ADMIN_MASTER is global, granted or revoked only by another ADMIN_MASTER, with a reason (audited). */
function AdminMasterDialog({ user, onClose, onComplete }: { user: ListedUser; onClose: () => void; onComplete: () => void }) {
  const [reason, setReason] = useState(""); const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null);
  const granting = !user.adminMaster;
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      const response = await fetch(`/api/v1/admin/users/${user.id}/admin-master`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ granted: granting, reason: reason.trim() }) });
      if (!response.ok) throw new Error(await readError(response));
      onComplete();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível alterar o ADMIN_MASTER."); } finally { setSaving(false); }
  }
  return <DialogFrame title={granting ? "Conceder ADMIN_MASTER" : "Revogar ADMIN_MASTER"} description={`${user.displayName ?? user.email} · ${user.email}`} onClose={onClose}>
    <form onSubmit={submit} className="mt-6 space-y-5">
      <p className="text-sm text-[var(--g-text-secondary)]">{granting ? "ADMIN_MASTER administra todas as turmas, cria e arquiva turmas e concede este acesso a outras pessoas." : "A pessoa perde a administração global; os papéis dela em cada turma continuam."}</p>
      <Field id={`master-reason-${user.id}`} label="Motivo"><Input id={`master-reason-${user.id}`} required minLength={4} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
      {error && <p role="alert" className="text-sm text-[var(--g-status-danger-foreground)]">{error}</p>}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"><Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" loading={saving} disabled={reason.trim().length < 4}>{granting ? "Conceder" : "Revogar"}</Button></div>
    </form>
  </DialogFrame>;
}

function LockBadges({ user }: { user: AdminUser }) {
  return <>{user.locks?.passwordRecovery && <Badge tone="danger" className="ml-1">Recuperação de senha bloqueada</Badge>}{user.locks?.signupCode && <Badge tone="danger" className="ml-1">Código de cadastro bloqueado</Badge>}</>;
}

/** Spec 5.17: requests blocked after too many attempts are unlocked by an administrator, with a reason, audited. */
function UnlockSection({ user, onComplete }: { user: AdminUser; onComplete: () => void }) {
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  async function unlock(kind: "password-recovery" | "signup-code") {
    setBusy(kind); setError(null);
    try {
      const response = await fetch(`/api/v1/admin/users/${user.id}/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: reason.trim() }) });
      if (!response.ok) throw new Error(await readError(response));
      onComplete();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível desbloquear."); } finally { setBusy(null); }
  }
  const valid = reason.trim().length >= 4;
  return <section aria-label="Desbloqueios" className="mt-6 space-y-3 border-t border-[var(--g-border-subtle)] pt-5">
    <h3 className="font-semibold">Desbloqueios</h3>
    <p className="text-sm text-[var(--g-text-secondary)]">O bloqueio protege a conta depois de muitas tentativas. Confirme a identidade da pessoa antes de liberar; o motivo fica na auditoria.</p>
    <Field id={`unlock-reason-${user.id}`} label="Motivo do desbloqueio"><Input id={`unlock-reason-${user.id}`} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} /></Field>
    {error && <p role="alert" className="text-sm text-[var(--g-status-danger-foreground)]">{error}</p>}
    <div className="flex flex-wrap gap-2">
      {user.locks?.passwordRecovery && <Button type="button" variant="secondary" loading={busy === "password-recovery"} disabled={!valid || busy !== null} onClick={() => void unlock("password-recovery")}>Desbloquear recuperação de senha</Button>}
      {user.locks?.signupCode && <Button type="button" variant="secondary" loading={busy === "signup-code"} disabled={!valid || busy !== null} onClick={() => void unlock("signup-code")}>Desbloquear código de cadastro</Button>}
    </div>
  </section>;
}

function UsersSkeleton() { return <div role="status" className="space-y-3 p-5" aria-label="Carregando usuários">{[1, 2, 3].map((item) => <div key={item} className="h-16 animate-pulse rounded-[var(--g-radius-control)] bg-[var(--g-surface-subtle)]" />)}</div>; }
