"use client";

import {
  announcementsResponseSchema, publishAnnouncementRequestSchema, publishAnnouncementResponseSchema,
  type Announcement, type AppRole,
} from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, Loader2, Megaphone } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
const roleLabels: Record<AppRole, string> = {
  CONSUMIDOR: "Consumidores", VENDEDOR: "Vendedores", ESTOQUE: "Estoque", FINANCEIRO: "Financeiro",
  COMUNICACAO: "Comunicação", MODERADOR: "Moderação", ADMIN: "Administradores",
};

async function messageFrom(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? fallback;
}

function audienceLabel(item: Announcement) {
  if (item.audienceAll) return "Todos";
  const parts = item.audienceRoles.map((role) => roleLabels[role as AppRole] ?? role);
  if (item.audienceEmails.length > 0) parts.push(`${item.audienceEmails.length} e-mail(s)`);
  return parts.join(", ");
}

/** Spec 5.15 (NOTIF-003): the communications team publishes in-app announcements to a chosen audience. */
export function AnnouncementsManagement() {
  const { showToast } = useToast();
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [all, setAll] = useState(false);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [emails, setEmails] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const keys = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/v1/admin/announcements", { cache: "no-store" });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível carregar os avisos."));
      const parsed = announcementsResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("A consulta retornou dados inválidos.");
      setItems(parsed.data.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar os avisos."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  const payload = publishAnnouncementRequestSchema.safeParse({
    title, body, all, roles: all ? [] : roles,
    emails: all ? [] : emails.split(/[\s,;]+/).map((email) => email.trim()).filter(Boolean),
  });

  async function publish() {
    if (!payload.success) return;
    const fingerprint = JSON.stringify(payload.data);
    const key = keys.current.get(fingerprint) ?? `announcement:${crypto.randomUUID()}`;
    keys.current.set(fingerprint, key);
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/v1/admin/announcements", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(payload.data),
      });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível publicar o aviso."));
      const parsed = publishAnnouncementResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("O aviso retornou dados inválidos.");
      showToast(`Aviso enviado para ${parsed.data.data.recipientCount} pessoa(s).`, "success");
      setTitle(""); setBody(""); setAll(false); setRoles([]); setEmails(""); setConfirming(false);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível publicar o aviso."); setConfirming(false); }
    finally { setBusy(false); }
  }

  return <div className="grid gap-6">
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-semibold"><Megaphone className="size-4" />Novo aviso</h2>
      <p className="mt-1 text-sm text-[var(--g-text-secondary)]">O aviso aparece na central de notificações de cada pessoa do público, que é fixado no envio.</p>
      <form aria-label="Novo aviso" className="mt-4 grid gap-4" onSubmit={(event) => { event.preventDefault(); if (confirming) void publish(); else if (payload.success) setConfirming(true); }}>
        <Field id="announcement-title" label="Título"><Input id="announcement-title" maxLength={160} value={title} onChange={(event) => { setTitle(event.target.value); setConfirming(false); }} /></Field>
        <Field id="announcement-body" label="Mensagem"><textarea id="announcement-body" className="g-input min-h-28 w-full py-2" maxLength={1000} value={body} onChange={(event) => { setBody(event.target.value); setConfirming(false); }} /></Field>
        <fieldset className="grid gap-2 text-sm"><legend className="font-semibold">Público</legend>
          <label className="flex items-center gap-2"><input type="checkbox" checked={all} onChange={(event) => { setAll(event.target.checked); setConfirming(false); }} />Todos com cadastro ativo</label>
          {!all && <div className="flex flex-wrap gap-3">{(Object.keys(roleLabels) as AppRole[]).map((role) => <label key={role} className="flex items-center gap-2"><input type="checkbox" checked={roles.includes(role)} onChange={(event) => { setRoles((current) => event.target.checked ? [...current, role] : current.filter((item) => item !== role)); setConfirming(false); }} />{roleLabels[role]}</label>)}</div>}
        </fieldset>
        {!all && <Field id="announcement-emails" label="E-mails específicos (opcional)" description="Separe por vírgula ou linha."><textarea id="announcement-emails" className="g-input min-h-20 w-full py-2" value={emails} onChange={(event) => { setEmails(event.target.value); setConfirming(false); }} /></Field>}
        {error && <div role="alert" className="flex items-start gap-2 text-sm text-[var(--g-status-danger)]"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><p>{error}</p></div>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant={confirming ? "brand" : "secondary"} loading={busy} disabled={!payload.success || busy}>{confirming ? "Confirmar envio" : "Enviar aviso"}</Button>
          {confirming && <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>Voltar</Button>}
        </div>
      </form>
    </Card>
    <Card className="overflow-hidden">
      {loading ? <p role="status" className="flex items-center gap-2 p-5 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Carregando avisos…</p>
        : items.length === 0 ? <p className="p-5 text-sm text-[var(--g-text-secondary)]">Nenhum aviso enviado ainda.</p>
        : <ul aria-label="Avisos enviados" className="divide-y divide-[var(--g-border-subtle)]">{items.map((item) => <li key={item.id} className="p-5" aria-label={`Aviso ${item.title}`}>
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="font-semibold">{item.title}</p><p className="mt-1 whitespace-pre-line text-sm text-[var(--g-text-secondary)]">{item.body}</p></div><Badge tone="info">{item.recipientCount} pessoa(s)</Badge></div>
          <p className="mt-2 text-xs text-[var(--g-text-muted)]">{dateTime.format(new Date(item.createdAt))} · {audienceLabel(item)} · {item.createdByName}</p>
        </li>)}</ul>}
    </Card>
  </div>;
}
