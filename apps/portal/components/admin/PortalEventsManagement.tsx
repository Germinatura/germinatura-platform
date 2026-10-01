"use client";

import {
  portalEventResponseSchema, portalEventsAdminResponseSchema, publicCatalogProductsResponseSchema, savePortalEventRequestSchema,
  type PortalEvent, type PortalEventKind, type PortalEventsAdminResponse, type PublicCatalogProduct,
} from "@germinatura/contracts";
import { Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, ImageUp, Loader2, Plus, Send, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { eventBadge, eventWhen } from "@/components/events/PortalEvents";
import { useToast } from "@/components/ui/Toast";

const localInput = (iso: string | null) => {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(iso)).reduce<Record<string, string>>((all, part) => ({ ...all, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};
// Brasília has no daylight saving time since 2019: the form's local time is UTC−03:00.
const toIso = (value: string) => value ? new Date(`${value}:00-03:00`).toISOString() : null;

type Form = {
  id: string | null; revision: number | null; kind: PortalEventKind; title: string; description: string; startsAt: string; endsAt: string;
  location: string; externalUrl: string; ctaLabel: string; ctaUrl: string; productIds: string[]; promotionIds: string[]; sellerIds: string[];
};
const emptyForm: Form = { id: null, revision: null, kind: "EVENTO", title: "", description: "", startsAt: "", endsAt: "", location: "", externalUrl: "", ctaLabel: "", ctaUrl: "", productIds: [], promotionIds: [], sellerIds: [] };
const formFrom = (event: PortalEvent): Form => ({
  id: event.id, revision: event.revision, kind: event.kind, title: event.title, description: event.description,
  startsAt: localInput(event.startsAt), endsAt: localInput(event.endsAt), location: event.location ?? "", externalUrl: event.externalUrl ?? "",
  ctaLabel: event.ctaLabel ?? "", ctaUrl: event.ctaUrl ?? "", productIds: event.products.map((item) => item.id),
  promotionIds: event.promotions.map((item) => item.id), sellerIds: event.sellers.map((item) => item.id),
});

async function messageFrom(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? fallback;
}

function Choices({ legend, options, selected, onChange }: { legend: string; options: { id: string; name: string }[]; selected: string[]; onChange: (ids: string[]) => void }) {
  if (options.length === 0) return null;
  return <fieldset className="sm:col-span-2"><legend className="text-sm font-medium">{legend}</legend>
    <div className="mt-2 flex max-h-40 flex-wrap gap-x-4 gap-y-2 overflow-y-auto">{options.map((option) => <label key={option.id} className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={selected.includes(option.id)} onChange={(event) => onChange(event.target.checked ? [...selected, option.id] : selected.filter((id) => id !== option.id))} />{option.name}
    </label>)}</div></fieldset>;
}

/** Spec 4.5: the communications team drafts, publishes and cancels events and campaigns. */
export function PortalEventsManagement() {
  const { showToast } = useToast();
  const [data, setData] = useState<PortalEventsAdminResponse | null>(null);
  const [products, setProducts] = useState<PublicCatalogProduct[]>([]);
  const [form, setForm] = useState<Form>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState<{ id: string; reason: string } | null>(null);
  const [cover, setCover] = useState<{ id: string; alt: string; file: File | null } | null>(null);
  const keys = useRef(new Map<string, string>());
  const keyFor = (scope: string, payload: unknown) => {
    const fingerprint = `${scope}:${JSON.stringify(payload)}`;
    const key = keys.current.get(fingerprint) ?? `event-${scope}:${crypto.randomUUID()}`;
    keys.current.set(fingerprint, key);
    return key;
  };

  const load = useCallback(async () => {
    const [eventsResponse, catalogResponse] = await Promise.all([
      fetch("/api/v1/admin/events", { cache: "no-store" }), fetch("/api/v1/catalog/products?limit=50", { cache: "no-store" }),
    ]);
    if (!eventsResponse.ok) throw new Error(await messageFrom(eventsResponse, "Não foi possível carregar os eventos."));
    const parsed = portalEventsAdminResponseSchema.safeParse(await eventsResponse.json());
    if (!parsed.success) throw new Error("A consulta retornou dados inválidos.");
    const catalog = publicCatalogProductsResponseSchema.safeParse(await catalogResponse.json().catch(() => null));
    setData(parsed.data);
    setProducts(catalog.success ? catalog.data.data : []);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Não foi possível carregar os eventos.")); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const payload = {
    expectedRevision: form.revision, kind: form.kind, title: form.title.trim(), description: form.description.trim(),
    startsAt: toIso(form.startsAt) ?? "", endsAt: toIso(form.endsAt), location: form.location.trim() || null,
    externalUrl: form.externalUrl.trim() || null, ctaLabel: form.ctaLabel.trim() || null, ctaUrl: form.ctaUrl.trim() || null,
    productIds: form.productIds, promotionIds: form.promotionIds, sellerIds: form.sellerIds,
  };
  const valid = savePortalEventRequestSchema.safeParse(payload);

  async function run(action: () => Promise<Response>, success: string, fallback: string) {
    setBusy(true); setError("");
    try {
      const response = await action();
      if (!response.ok) throw new Error(await messageFrom(response, fallback));
      if (!portalEventResponseSchema.safeParse(await response.json()).success) throw new Error("A resposta veio inválida.");
      showToast(success, "success");
      await load();
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : fallback); return false; }
    finally { setBusy(false); }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!valid.success) { setError(valid.error.issues[0]?.message ?? "Confira os dados do evento."); return; }
    const ok = await run(() => fetch(form.id ? `/api/v1/admin/events/${form.id}` : "/api/v1/admin/events", {
      method: form.id ? "PUT" : "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": keyFor(`save-${form.id ?? "new"}`, valid.data) },
      body: JSON.stringify(valid.data),
    }), form.id ? "Evento atualizado." : "Rascunho criado.", "Não foi possível salvar o evento.");
    if (ok) setForm(emptyForm);
  }

  const transition = (eventId: string, body: { action: "PUBLICAR" } | { action: "CANCELAR"; reason: string }) => run(() => fetch(`/api/v1/admin/events/${eventId}/transition`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": keyFor(`transition-${eventId}`, body) }, body: JSON.stringify(body),
  }), body.action === "PUBLICAR" ? "Evento publicado." : "Evento cancelado.", "Não foi possível alterar o evento.");

  async function uploadCover() {
    if (!cover?.file || !cover.alt.trim()) return;
    const file = cover.file;
    const ok = await run(() => fetch(`/api/v1/admin/events/${cover.id}/cover?${new URLSearchParams({ alt: cover.alt.trim() })}`, {
      method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", "Idempotency-Key": `event-cover:${crypto.randomUUID()}` }, body: file,
    }), "Capa atualizada.", "Não foi possível enviar a capa.");
    if (ok) setCover(null);
  }

  const events = data?.data ?? [];
  return <div className="grid gap-6">
    <Card className="p-5">
      <h2 className="font-semibold">{form.id ? "Editar evento" : "Novo evento ou campanha"}</h2>
      <p className="mt-1 text-sm text-[var(--g-text-secondary)]">O evento nasce como rascunho. Ao publicar, ele aparece em Eventos e campanhas e avisa quem mantém a categoria Eventos ligada. Datas e horários de Brasília.</p>
      <form aria-label="Evento" onSubmit={save} className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field id="event-kind" label="Tipo"><select id="event-kind" className="g-input min-h-11 w-full" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as PortalEventKind })}><option value="EVENTO">Evento ou festa</option><option value="CAMPANHA">Campanha de venda</option></select></Field>
        <Field id="event-title" label="Título"><Input id="event-title" maxLength={120} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></Field>
        <Field id="event-description" label="Descrição" className="sm:col-span-2"><textarea id="event-description" className="g-input min-h-24 w-full" maxLength={4000} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
        <Field id="event-starts" label="Início"><Input id="event-starts" type="datetime-local" value={form.startsAt} onChange={(event) => setForm({ ...form, startsAt: event.target.value })} /></Field>
        <Field id="event-ends" label="Fim (opcional)"><Input id="event-ends" type="datetime-local" value={form.endsAt} onChange={(event) => setForm({ ...form, endsAt: event.target.value })} /></Field>
        <Field id="event-location" label="Local (opcional)"><Input id="event-location" maxLength={160} value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} /></Field>
        <Field id="event-external" label="Link externo (opcional)"><Input id="event-external" type="url" placeholder="https://" maxLength={500} value={form.externalUrl} onChange={(event) => setForm({ ...form, externalUrl: event.target.value })} /></Field>
        <Field id="event-cta-label" label="Chamada para ação (opcional)" description="Ex.: Reservar ingresso"><Input id="event-cta-label" maxLength={40} value={form.ctaLabel} onChange={(event) => setForm({ ...form, ctaLabel: event.target.value })} /></Field>
        <Field id="event-cta-url" label="Link da chamada" description="https:// ou um caminho do Portal, como /catalogo"><Input id="event-cta-url" maxLength={500} value={form.ctaUrl} onChange={(event) => setForm({ ...form, ctaUrl: event.target.value })} /></Field>
        <Choices legend="Produtos" options={products.map((product) => ({ id: product.id, name: product.name }))} selected={form.productIds} onChange={(productIds) => setForm({ ...form, productIds })} />
        <Choices legend="Promoções e combos" options={data?.promotions ?? []} selected={form.promotionIds} onChange={(promotionIds) => setForm({ ...form, promotionIds })} />
        <Choices legend="Vendedores participantes" options={data?.sellers ?? []} selected={form.sellerIds} onChange={(sellerIds) => setForm({ ...form, sellerIds })} />
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <Button type="submit" loading={busy} disabled={busy || !valid.success}><Plus className="size-4" />{form.id ? "Salvar alterações" : "Criar rascunho"}</Button>
          {form.id && <Button type="button" variant="ghost" disabled={busy} onClick={() => setForm(emptyForm)}>Cancelar edição</Button>}
        </div>
      </form>
    </Card>
    {error && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 p-4 text-sm"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--g-status-danger)]" /><p>{error}</p></div>}
    <Card className="overflow-hidden">
      {!data ? <p role="status" className="flex items-center gap-2 p-5 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Carregando eventos…</p>
        : events.length === 0 ? <p className="p-5 text-sm text-[var(--g-text-secondary)]">Nenhum evento cadastrado.</p>
        : <ul aria-label="Eventos" className="divide-y divide-[var(--g-border-subtle)]">{events.map((event) => <li key={event.id} aria-label={event.title} className="grid gap-3 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0"><p className="font-semibold">{event.title}</p><p className="text-sm text-[var(--g-text-secondary)]">{eventWhen(event)}{event.location ? ` · ${event.location}` : ""}{event.coverUrl ? " · com capa" : ""}</p></div>
            {eventBadge(event)}
          </div>
          {event.status !== "CANCELADO" && <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setForm(formFrom(event))}>Editar</Button>
            {event.status === "RASCUNHO" && !event.over && <Button type="button" size="sm" disabled={busy} onClick={() => void transition(event.id, { action: "PUBLICAR" })}><Send className="size-4" />Publicar</Button>}
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setCover({ id: event.id, alt: event.coverAlt ?? "", file: null })}><ImageUp className="size-4" />Capa</Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setCancelling({ id: event.id, reason: "" })}><XCircle className="size-4" />Cancelar evento</Button>
          </div>}
          {cover?.id === event.id && <div className="flex flex-wrap items-end gap-2">
            <Field id={`cover-file-${event.id}`} label="Imagem (JPG, PNG ou WebP, até 5 MB)"><input id={`cover-file-${event.id}`} type="file" accept="image/jpeg,image/png,image/webp" className="g-input min-h-11" onChange={(change) => setCover({ ...cover, file: change.target.files?.[0] ?? null })} /></Field>
            <Field id={`cover-alt-${event.id}`} label="Descrição da imagem" className="min-w-64 flex-1"><Input id={`cover-alt-${event.id}`} maxLength={180} value={cover.alt} onChange={(change) => setCover({ ...cover, alt: change.target.value })} /></Field>
            <Button type="button" size="sm" loading={busy} disabled={busy || !cover.file || !cover.alt.trim()} onClick={() => void uploadCover()}>Enviar capa</Button>
          </div>}
          {cancelling?.id === event.id && <div className="flex flex-wrap items-end gap-2">
            <Field id={`cancel-reason-${event.id}`} label="Motivo do cancelamento" className="min-w-64 flex-1"><Input id={`cancel-reason-${event.id}`} maxLength={300} value={cancelling.reason} onChange={(change) => setCancelling({ id: event.id, reason: change.target.value })} /></Field>
            <Button type="button" size="sm" variant="danger" loading={busy} disabled={busy || cancelling.reason.trim().length < 8} onClick={() => void transition(event.id, { action: "CANCELAR", reason: cancelling.reason.trim() }).then((ok) => ok && setCancelling(null))}>Confirmar cancelamento</Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setCancelling(null)}>Voltar</Button>
          </div>}
        </li>)}</ul>}
    </Card>
  </div>;
}
