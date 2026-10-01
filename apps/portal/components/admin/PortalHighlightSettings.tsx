"use client";

import { portalHighlightResponseSchema, savePortalHighlightRequestSchema } from "@germinatura/contracts";
import { Button, Card, Field, Input } from "@germinatura/ui";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";

// Brasília has no daylight saving time since 2019: the form's local time is UTC−03:00.
const toIso = (value: string) => value ? new Date(`${value}:00-03:00`).toISOString() : null;
const toLocal = (iso: string | null) => iso ? new Date(new Date(iso).getTime() - 3 * 3_600_000).toISOString().slice(0, 16) : "";

/** Spec 4.1: the highlight at the top of the Início page, configured by the communications team. */
export function PortalHighlightSettings() {
  const { showToast } = useToast();
  const [form, setForm] = useState({ title: "", message: "", ctaLabel: "", ctaUrl: "", active: true, visibleUntil: "" });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const keys = useRef(new Map<string, string>());
  useEffect(() => {
    const timer = window.setTimeout(async () => {
      const response = await fetch("/api/v1/admin/showcase/highlight", { cache: "no-store" }).catch(() => null);
      const parsed = portalHighlightResponseSchema.safeParse(await response?.json().catch(() => null));
      if (parsed.success && parsed.data.data) {
        const value = parsed.data.data;
        setForm({ title: value.title, message: value.message ?? "", ctaLabel: value.ctaLabel ?? "", ctaUrl: value.ctaUrl ?? "", active: value.active, visibleUntil: toLocal(value.visibleUntil) });
      }
      setLoaded(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const payload = {
    title: form.title.trim(), message: form.message.trim() || null, ctaLabel: form.ctaLabel.trim() || null, ctaUrl: form.ctaUrl.trim() || null,
    active: form.active, visibleUntil: toIso(form.visibleUntil),
  };
  const valid = savePortalHighlightRequestSchema.safeParse(payload);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!valid.success) { setError(valid.error.issues[0]?.message ?? "Confira o destaque."); return; }
    setBusy(true); setError("");
    try {
      const fingerprint = JSON.stringify(valid.data);
      const key = keys.current.get(fingerprint) ?? `highlight:${crypto.randomUUID()}`;
      keys.current.set(fingerprint, key);
      const response = await fetch("/api/v1/admin/showcase/highlight", { method: "PUT", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: fingerprint });
      if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { message?: string } | null)?.message ?? "Não foi possível salvar o destaque.");
      showToast(form.active ? "Destaque publicado no Início." : "Destaque desligado.", "success");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar o destaque."); }
    finally { setBusy(false); }
  }
  return <Card className="p-5">
    <h2 className="font-semibold">Destaque do Início</h2>
    <p className="mt-1 text-sm text-[var(--g-text-secondary)]">Aparece no topo da página Início de todos. Cada alteração fica registrada.</p>
    <form aria-label="Destaque do Início" onSubmit={save} className="mt-4 grid gap-4 sm:grid-cols-2">
      <Field id="highlight-title" label="Título"><Input id="highlight-title" maxLength={80} disabled={!loaded} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></Field>
      <Field id="highlight-until" label="Mostrar até (opcional)"><Input id="highlight-until" type="datetime-local" disabled={!loaded} value={form.visibleUntil} onChange={(event) => setForm({ ...form, visibleUntil: event.target.value })} /></Field>
      <Field id="highlight-message" label="Mensagem (opcional)" className="sm:col-span-2"><Input id="highlight-message" maxLength={280} disabled={!loaded} value={form.message} onChange={(event) => setForm({ ...form, message: event.target.value })} /></Field>
      <Field id="highlight-cta-label" label="Chamada para ação (opcional)"><Input id="highlight-cta-label" maxLength={40} disabled={!loaded} value={form.ctaLabel} onChange={(event) => setForm({ ...form, ctaLabel: event.target.value })} /></Field>
      <Field id="highlight-cta-url" label="Link da chamada" description="https:// ou um caminho do Portal, como /eventos"><Input id="highlight-cta-url" maxLength={500} disabled={!loaded} value={form.ctaUrl} onChange={(event) => setForm({ ...form, ctaUrl: event.target.value })} /></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!loaded} checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} />Mostrar no Início</label>
      <div className="flex items-end justify-end"><Button type="submit" loading={busy} disabled={busy || !loaded || !valid.success}>Salvar destaque</Button></div>
      {error && <p role="alert" className="text-sm text-[var(--g-status-danger)] sm:col-span-2">{error}</p>}
    </form>
  </Card>;
}
