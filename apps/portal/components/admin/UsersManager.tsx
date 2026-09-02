"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Pencil, Plus, Search, UserRoundCog, X } from "lucide-react";
import { adminUsersResponseSchema, type AdminProvisionUser, type AdminUser, type AppRole } from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";

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

export function UsersManager() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch("/api/v1/admin/users", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      setUsers(adminUsersResponseSchema.parse(await response.json()).data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível consultar os usuários.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/v1/admin/users", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readError(response));
        return adminUsersResponseSchema.parse(await response.json()).data;
      })
      .then((data) => { if (active) setUsers(data); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Não foi possível consultar os usuários."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    if (!normalized) return users;
    return users.filter((user) => [user.displayName, user.email, user.username, ...user.roles].some((value) => value?.toLocaleLowerCase("pt-BR").includes(normalized)));
  }, [query, users]);

  function completed(message: string) {
    setNotice(message); setCreateOpen(false); setEditing(null); void loadUsers();
  }

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div><p className="text-sm font-semibold text-[var(--g-brand-primary)]">Gestão de acesso</p><h1 className="mt-1 text-3xl font-bold tracking-tight">Usuários e vendedores</h1><p className="mt-2 max-w-2xl text-base text-[var(--g-text-secondary)]">Crie contas operacionais, atribua papéis cumulativos e revogue acessos imediatamente.</p></div>
          <Button type="button" onClick={() => { setNotice(null); setCreateOpen(true); }}><Plus className="size-5" /> Adicionar usuário</Button>
        </header>

        {notice && <div role="status" className="flex items-center gap-3 rounded-[var(--g-radius-control)] bg-[var(--g-status-success-soft)] p-4 text-sm text-[var(--g-status-success-foreground)]"><Check className="size-5" />{notice}</div>}
        {error && <div role="alert" className="rounded-[var(--g-radius-control)] bg-[var(--g-status-danger-soft)] p-4 text-sm text-[var(--g-status-danger-foreground)]"><p>{error}</p><button type="button" onClick={() => void loadUsers()} className="mt-2 min-h-11 font-semibold underline">Tentar novamente</button></div>}

        <Card className="overflow-hidden">
          <div className="flex flex-col gap-4 border-b border-[var(--g-border-subtle)] p-5 sm:flex-row sm:items-center sm:justify-between">
            <div><h2 className="text-lg font-bold">Contas cadastradas</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">{loading ? "Consultando…" : `${filtered.length} de ${users.length} contas`}</p></div>
            <label className="relative block w-full sm:max-w-sm"><span className="sr-only">Buscar usuários</span><Search className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-[var(--g-text-muted)]" /><Input value={query} onChange={(event) => setQuery(event.target.value)} className="pl-10" placeholder="Nome, e-mail, usuário ou papel" /></label>
          </div>
          {loading ? <UsersSkeleton /> : !error && filtered.length === 0 ? <div className="p-10 text-center"><UserRoundCog className="mx-auto size-10 text-[var(--g-text-muted)]" /><p className="mt-4 font-semibold">Nenhum usuário encontrado</p><p className="mt-1 text-sm text-[var(--g-text-secondary)]">Ajuste a busca ou adicione uma nova conta operacional.</p></div> : !error && <UsersList users={filtered} onEdit={setEditing} />}
        </Card>
      </div>
      {createOpen && <CreateUserDialog onClose={() => setCreateOpen(false)} onComplete={() => completed("Conta criada e acesso configurado.")} />}
      {editing && <EditAccessDialog user={editing} onClose={() => setEditing(null)} onComplete={() => completed("Papéis e estado de acesso atualizados.")} />}
    </div>
  );
}

function UsersList({ users, onEdit }: { users: AdminUser[]; onEdit: (user: AdminUser) => void }) {
  return <>
    <div className="hidden overflow-x-auto md:block"><table className="w-full text-left text-sm"><thead className="bg-[var(--g-surface-subtle)] text-xs uppercase tracking-wide text-[var(--g-text-muted)]"><tr><th className="px-6 py-3 font-semibold">Pessoa</th><th className="px-6 py-3 font-semibold">Papéis</th><th className="px-6 py-3 font-semibold">Estado</th><th className="px-6 py-3 text-right font-semibold">Ações</th></tr></thead><tbody className="divide-y divide-[var(--g-border-subtle)]">{users.map((user) => <tr key={user.id} className="hover:bg-[var(--g-surface-hover)]"><td className="px-6 py-4"><p className="font-semibold">{user.displayName ?? user.email}</p><p className="mt-1 text-xs text-[var(--g-text-muted)]">@{user.username ?? "cadastro-incompleto"} · {user.email}</p></td><td className="px-6 py-4"><div className="flex max-w-md flex-wrap gap-1">{user.roles.map((role) => <Badge key={role} tone="info">{roleLabels[role]}</Badge>)}</div></td><td className="px-6 py-4"><Badge tone={user.active ? "success" : "danger"}>{user.active ? "Ativo" : "Inativo"}</Badge>{!user.onboardingCompleted && <Badge tone="warning" className="ml-1">Cadastro incompleto</Badge>}</td><td className="px-6 py-4 text-right"><Button variant="ghost" size="sm" onClick={() => onEdit(user)} aria-label={`Editar acesso de ${user.displayName ?? user.email}`}><Pencil className="size-4" /> Editar</Button></td></tr>)}</tbody></table></div>
    <div className="divide-y divide-[var(--g-border-subtle)] md:hidden">{users.map((user) => <article key={user.id} className="space-y-4 p-5"><div><p className="font-semibold">{user.displayName ?? user.email}</p><p className="mt-1 break-all text-sm text-[var(--g-text-muted)]">{user.email}</p></div><div className="flex flex-wrap gap-1">{user.roles.map((role) => <Badge key={role} tone="info">{roleLabels[role]}</Badge>)}</div><div className="flex items-center justify-between gap-3"><Badge tone={user.active ? "success" : "danger"}>{user.active ? "Ativo" : "Inativo"}</Badge><Button variant="secondary" size="sm" onClick={() => onEdit(user)}><Pencil className="size-4" /> Editar acesso</Button></div></article>)}</div>
  </>;
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

function EditAccessDialog({ user, onClose, onComplete }: { user: AdminUser; onClose: () => void; onComplete: () => void }) {
  const [roles, setRoles] = useState<AppRole[]>(user.roles); const [active, setActive] = useState(user.active); const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) { event.preventDefault(); setSaving(true); setError(null); try { const response = await fetch(`/api/v1/admin/users/${user.id}/roles`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roles: Array.from(new Set([...roles, "CONSUMIDOR"])), active }) }); if (!response.ok) throw new Error(await readError(response)); onComplete(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível atualizar o acesso."); } finally { setSaving(false); } }
  return <DialogFrame title="Editar acesso" description={`${user.displayName ?? user.email} · ${user.email}`} onClose={onClose}><form onSubmit={submit} className="mt-6 space-y-5"><RoleOptions roles={roles} setRoles={setRoles} options={editableRoles} /><label className="flex min-h-11 items-center gap-3 rounded-[var(--g-radius-control)] border border-[var(--g-border-subtle)] px-3 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-4 accent-[var(--g-brand-primary)]" /><span><strong className="block">Conta ativa</strong><span className="text-xs text-[var(--g-text-muted)]">Desmarcar revoga o acesso ao Portal e ao PDV imediatamente.</span></span></label>{error && <p role="alert" className="text-sm text-[var(--g-status-danger-foreground)]">{error}</p>}<div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"><Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" loading={saving}>Salvar alterações</Button></div></form></DialogFrame>;
}

function UsersSkeleton() { return <div className="space-y-3 p-5" aria-label="Carregando usuários">{[1, 2, 3].map((item) => <div key={item} className="h-16 animate-pulse rounded-[var(--g-radius-control)] bg-[var(--g-surface-subtle)]" />)}</div>; }
