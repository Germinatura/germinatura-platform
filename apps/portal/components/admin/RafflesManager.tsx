"use client";

import {
  adminRaffleBuyersResponseSchema, raffleCampaignCreateRequestSchema, raffleCampaignResponseSchema, raffleCampaignUpdateRequestSchema,
  raffleDrawResponseSchema, type AdminRaffleBuyer, type AdminRaffleCampaign, type RaffleCampaignStatus,
} from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, Ticket } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";

interface Option { id: string; name: string; }
interface Props { campaigns: AdminRaffleCampaign[]; products: Option[]; locations: Option[]; enabled: boolean; unavailable: boolean; }
type Confirmation = { campaign: AdminRaffleCampaign; action: "close" | "draw" | "publish" | "pause" | "resume" | "cancel" };

const labels: Record<RaffleCampaignStatus, string> = { DRAFT: "Rascunho", ACTIVE: "Aberta", PAUSED: "Pausada", CLOSED: "Encerrada", DRAWN: "Sorteada", CANCELLED: "Cancelada" };
const tones: Record<RaffleCampaignStatus, "neutral" | "success" | "warning" | "info" | "danger"> = { DRAFT: "neutral", ACTIVE: "success", PAUSED: "warning", CLOSED: "info", DRAWN: "info", CANCELLED: "danger" };
const date = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const successMessages = {
  create: "Campanha criada e auditada.", update: "Rascunho atualizado.", publish: "Rifa publicada. As vendas estão abertas.",
  pause: "Vendas pausadas. Reservas existentes seguem até pagar ou expirar.", resume: "Vendas retomadas.",
  close: "Campanha encerrada. Novas reservas estão bloqueadas.", cancel: "Rifa cancelada. Reservas pendentes foram liberadas.",
  draw: "Sorteio registrado. O resultado é único e não pode ser repetido.",
};
const confirmTexts: Record<Confirmation["action"], string> = {
  publish: "Depois de publicada, a quantidade de números, o produto e o período não podem mais mudar.",
  pause: "Novas reservas ficam bloqueadas; reservas já feitas seguem até pagar ou expirar.",
  resume: "As vendas voltam a aceitar reservas até o encerramento do período.",
  close: "O encerramento bloqueia novas reservas e congela os números pagos que participam do sorteio.",
  draw: "O sorteio será executado uma única vez no servidor, somente entre números pagos. Não é possível escolher ou repetir o resultado.",
  cancel: "Reservas pendentes serão liberadas. Vendas já pagas continuam registradas e precisam ser estornadas pelo financeiro.",
};
const confirmButtons: Record<Confirmation["action"], string> = {
  publish: "Confirmar publicação", pause: "Confirmar pausa", resume: "Confirmar retomada", close: "Confirmar encerramento",
  draw: "Confirmar sorteio único", cancel: "Confirmar cancelamento",
};
const toLocalInput = (iso: string) => { const value = new Date(iso); return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };

/** Spec 5.11: raffle lifecycle — draft, publish, pause/resume, close, cancel and the auditable draw. */
export function RafflesManager({ campaigns: loaded, products, locations, enabled, unavailable }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  // Status the server just returned, shown until a refresh brings the same status (refreshes can arrive out of order).
  const [overrides, setOverrides] = useState<Record<string, RaffleCampaignStatus>>({});
  const campaigns = useMemo(() => loaded.map((campaign) => {
    const status = overrides[campaign.campaignId];
    return status && status !== campaign.status ? { ...campaign, status } : campaign;
  }), [loaded, overrides]);
  const lock = useRef(false);
  const keys = useRef(new Map<string, string>());
  const disabled = busy || unavailable || !enabled;

  async function perform(path: string, method: "POST" | "PATCH", payload: unknown, action: keyof typeof successMessages) {
    if (lock.current || unavailable || !enabled) return false;
    if (!navigator.onLine) { setError("Sem internet. Reconecte antes de alterar uma campanha ou realizar um sorteio."); return false; }
    lock.current = true; setBusy(true); setError(""); setMessage("");
    const fingerprint = JSON.stringify([path, method, payload]);
    const key = keys.current.get(fingerprint) ?? `raffle-${action}:${crypto.randomUUID()}`;
    keys.current.set(fingerprint, key);
    try {
      const response = await fetch(path, { method, headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(payload) });
      const body: unknown = await response.json();
      if (!response.ok) {
        const detail = body as { message?: unknown };
        throw new Error(typeof detail?.message === "string" ? detail.message : "Não foi possível concluir. Recarregue os dados antes de tentar novamente.");
      }
      const campaign = action === "draw" ? null : raffleCampaignResponseSchema.safeParse(body);
      if (action === "draw" ? !raffleDrawResponseSchema.safeParse(body).success : !campaign?.success) {
        throw new Error("O servidor retornou uma resposta inesperada. Recarregue os dados antes de tentar novamente.");
      }
      if (campaign?.success) setOverrides((current) => ({ ...current, [campaign.data.data.campaignId]: campaign.data.data.status }));
      setMessage(successMessages[action]);
      setConfirmation(null); setEditingId(null); setCancelReason(""); router.refresh(); return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir. Tente novamente com a mesma operação."); return false;
    } finally { lock.current = false; setBusy(false); }
  }

  function readStructure(form: HTMLFormElement) {
    const values = new FormData(form);
    const start = new Date(String(values.get("startsAt")));
    const end = new Date(String(values.get("endsAt")));
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) { setError("Informe datas válidas para início e encerramento."); return null; }
    return { values, startsAt: start.toISOString(), endsAt: end.toISOString() };
  }

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const read = readStructure(form); if (!read) return;
    const parsed = raffleCampaignCreateRequestSchema.safeParse({ name: read.values.get("name"), productId: read.values.get("productId"), locationId: read.values.get("locationId"), numberCount: Number(read.values.get("numberCount")), startsAt: read.startsAt, endsAt: read.endsAt });
    if (!parsed.success) { setError("Revise os campos: use de 1 a 10.000 números e um encerramento posterior ao início."); return; }
    if (await perform("/api/v1/admin/raffles", "POST", parsed.data, "create")) form.reset();
  }

  async function update(event: React.FormEvent<HTMLFormElement>, campaign: AdminRaffleCampaign) {
    event.preventDefault();
    const read = readStructure(event.currentTarget); if (!read) return;
    const description = String(read.values.get("description") ?? "").trim();
    const parsed = raffleCampaignUpdateRequestSchema.safeParse({ name: read.values.get("name"), description: description || null, productId: read.values.get("productId"), locationId: read.values.get("locationId"), numberCount: Number(read.values.get("numberCount")), startsAt: read.startsAt, endsAt: read.endsAt });
    if (!parsed.success) { setError("Revise os campos: use de 1 a 10.000 números e um encerramento posterior ao início."); return; }
    await perform(`/api/v1/admin/raffles/${campaign.campaignId}`, "PATCH", parsed.data, "update");
  }

  function confirm() {
    if (!confirmation) return;
    const { campaign, action } = confirmation;
    const base = `/api/v1/admin/raffles/${campaign.campaignId}`;
    if (action === "draw") void perform(`${base}/draw`, "POST", {}, "draw");
    else if (action === "cancel") void perform(`${base}/cancel`, "POST", { reason: cancelReason.trim() }, "cancel");
    else void perform(`${base}/transition`, "POST", { action: action.toUpperCase() }, action);
  }

  const ask = (campaign: AdminRaffleCampaign, action: Confirmation["action"]) => { setError(""); setCancelReason(""); setConfirmation({ campaign, action }); };
  const filtered = campaigns.filter((item) => item.name.toLocaleLowerCase("pt-BR").includes(query.trim().toLocaleLowerCase("pt-BR")));
  return <div className="px-4 py-8 sm:px-6 lg:px-8"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header><h1 className="text-3xl font-bold">Gestão de rifas</h1><p className="mt-2 text-[var(--g-text-secondary)]">Crie a rifa como rascunho, publique, pause, encerre e sorteie com resultado auditável. Apenas números pagos participam do sorteio.</p></header>
    {(unavailable || !enabled) && <Card className="flex gap-3 p-4"><AlertTriangle className="size-5 shrink-0" /><p role="alert">{unavailable ? "Não foi possível carregar os dados. Recarregue a página; as ações estão bloqueadas." : "Rifas estão desabilitadas. As ações permanecem bloqueadas pela flag."}</p></Card>}
    {message && <p role="status" className="rounded-[var(--g-radius-control)] bg-[var(--g-status-success-soft)] p-4 text-[var(--g-status-success-foreground)]">{message}</p>}
    <Card className="p-5"><details><summary className="min-h-11 cursor-pointer py-3 font-semibold">Nova campanha</summary>
      <p className="mb-4 text-sm text-[var(--g-text-secondary)]">A campanha nasce como rascunho e pode ser ajustada até a publicação. O preço de cada número vem do produto vinculado.</p>
      {(!products.length || !locations.length) && <p className="mb-4 text-sm">É necessário um produto ativo e publicado e uma localização central ativa.</p>}
      <form onSubmit={create}><fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2">
        <StructureFields prefix="raffle" products={products} locations={locations} />
        <Button type="submit" loading={busy} disabled={disabled || !products.length || !locations.length}>Criar campanha</Button>
      </fieldset>{error && !confirmation && !editingId && <p role="alert" className="mt-4 text-[var(--g-status-danger-foreground)]">{error}</p>}</form>
    </details></Card>
    <section className="space-y-4" aria-label="Campanhas de rifas"><div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-xl font-semibold">Campanhas recentes</h2><p className="text-sm text-[var(--g-text-secondary)]">Até 50 campanhas mais recentes.</p></div><Field id="raffle-search" label="Buscar campanha"><Input id="raffle-search" value={query} onChange={(event) => setQuery(event.target.value)} /></Field></div>
      {!unavailable && !filtered.length && <Card className="p-8 text-center"><Ticket className="mx-auto size-8" /><h3 className="mt-3 font-semibold">Nenhuma campanha encontrada</h3><p className="mt-2 text-sm">Crie uma campanha ou ajuste a busca.</p></Card>}
      {!unavailable && filtered.map((campaign) => {
        const selected = confirmation?.campaign.campaignId === campaign.campaignId;
        const selling = campaign.status === "ACTIVE" || campaign.status === "PAUSED";
        return <Card key={campaign.campaignId} className="space-y-4 p-5">
          <div className="flex items-start justify-between gap-3"><div><h3 className="text-lg font-semibold">{campaign.name}</h3><p className="mt-1 text-sm text-[var(--g-text-secondary)]">{campaign.productName} · {campaign.numberCount} números · {date.format(new Date(campaign.startsAt))} até {date.format(new Date(campaign.endsAt))} (Brasília)</p>{campaign.description && <p className="mt-1 text-sm">{campaign.description}</p>}</div><Badge tone={tones[campaign.status]}>{labels[campaign.status]}</Badge></div>
          {campaign.status !== "DRAFT" && <dl aria-label={`Ocupação de ${campaign.name}`} className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div><dt className="text-[var(--g-text-muted)]">Disponíveis</dt><dd className="font-semibold">{campaign.availableCount}</dd></div>
            <div><dt className="text-[var(--g-text-muted)]">Reservados</dt><dd className="font-semibold">{campaign.reservedCount}</dd></div>
            <div><dt className="text-[var(--g-text-muted)]">Pagos</dt><dd className="font-semibold">{campaign.paidCount}</dd></div>
            <div><dt className="text-[var(--g-text-muted)]">Arrecadado</dt><dd className="font-semibold">{money.format(campaign.paidTotalCents / 100)}</dd></div>
          </dl>}
          {campaign.status === "CANCELLED" && <p className="text-sm">Cancelada: {campaign.cancelReason}{campaign.paidSales > 0 ? ` · ${campaign.paidSales} venda(s) paga(s) a estornar pelo financeiro.` : ""}</p>}
          {campaign.draw && <div className="space-y-3"><p className="text-xl font-bold">Número vencedor: {campaign.draw.winnerNumber}</p><details><summary className="min-h-11 cursor-pointer py-3 font-semibold">Evidências do sorteio</summary><dl className="space-y-3 break-all text-sm">
            <div><dt className="font-semibold">Instante</dt><dd>{date.format(new Date(campaign.draw.drawnAt))} (Brasília)</dd></div>
            <div><dt className="font-semibold">Algoritmo</dt><dd>SHA-256(id da campanha : números elegíveis ordenados : material aleatório de 256 bits); posição = (primeiros 60 bits do hash mod total) + 1</dd></div>
            <div><dt className="font-semibold">Números elegíveis (ordenados)</dt><dd>{campaign.draw.eligibleNumbers.join(", ")}</dd></div>
            <div><dt className="font-semibold">Posição sorteada</dt><dd>{campaign.draw.winnerIndex}</dd></div>
            <div><dt className="font-semibold">Material aleatório</dt><dd>{campaign.draw.randomMaterial}</dd></div>
            <div><dt className="font-semibold">Hash de auditoria</dt><dd>{campaign.draw.auditHash}</dd></div>
          </dl></details></div>}
          {campaign.status !== "DRAFT" && <RaffleBuyers campaign={campaign} />}
          <div className="flex flex-wrap gap-2">
            {campaign.status === "DRAFT" && <><Button disabled={disabled} variant="secondary" onClick={() => { setError(""); setEditingId(editingId === campaign.campaignId ? null : campaign.campaignId); }}>Editar rascunho</Button><Button disabled={disabled} onClick={() => ask(campaign, "publish")}>Publicar</Button></>}
            {campaign.status === "ACTIVE" && <Button disabled={disabled} variant="secondary" onClick={() => ask(campaign, "pause")}>Pausar vendas</Button>}
            {campaign.status === "PAUSED" && <Button disabled={disabled} variant="secondary" onClick={() => ask(campaign, "resume")}>Retomar vendas</Button>}
            {selling && <Button disabled={disabled} variant="secondary" onClick={() => ask(campaign, "close")}>Encerrar reservas</Button>}
            {campaign.status === "CLOSED" && <Button disabled={disabled} onClick={() => ask(campaign, "draw")}>Preparar sorteio</Button>}
            {["DRAFT", "ACTIVE", "PAUSED", "CLOSED"].includes(campaign.status) && <Button disabled={disabled} variant="ghost" onClick={() => ask(campaign, "cancel")}>Cancelar rifa</Button>}
          </div>
          {editingId === campaign.campaignId && <form aria-label={`Editar ${campaign.name}`} onSubmit={(event) => void update(event, campaign)}><fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2">
            <StructureFields prefix={`edit-${campaign.campaignId}`} products={products} locations={locations} campaign={campaign} />
            <Button type="submit" loading={busy}>Salvar rascunho</Button>
          </fieldset>{error && <p role="alert" className="mt-4 text-[var(--g-status-danger-foreground)]">{error}</p>}</form>}
          {selected && <section aria-label="Confirmar operação" className="space-y-3 rounded-[var(--g-radius-control)] bg-[var(--g-status-warning-soft)] p-4">
            <p className="text-sm text-[var(--g-status-warning-foreground)]">{confirmTexts[confirmation.action]}</p>
            {confirmation.action === "cancel" && <Field id={`cancel-${campaign.campaignId}`} label="Motivo do cancelamento"><Input id={`cancel-${campaign.campaignId}`} maxLength={300} value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} /></Field>}
            <div className="flex flex-wrap gap-2"><Button disabled={disabled || (confirmation.action === "cancel" && cancelReason.trim().length < 3)} loading={busy} variant={confirmation.action === "cancel" ? "danger" : "brand"} onClick={confirm}>{confirmButtons[confirmation.action]}</Button><Button variant="ghost" disabled={busy} onClick={() => setConfirmation(null)}>Voltar</Button></div>
          </section>}
          {selected && error && <p role="alert" className="text-[var(--g-status-danger-foreground)]">{error}</p>}
        </Card>;
      })}
    </section>
  </div></div>;
}

function StructureFields({ prefix, products, locations, campaign }: { prefix: string; products: Option[]; locations: Option[]; campaign?: AdminRaffleCampaign }) {
  return <>
    <Field id={`${prefix}-name`} label="Nome da campanha"><Input id={`${prefix}-name`} name="name" required maxLength={160} defaultValue={campaign?.name} /></Field>
    <Field id={`${prefix}-count`} label="Quantidade de números"><Input id={`${prefix}-count`} name="numberCount" type="number" required min={1} max={10000} step={1} defaultValue={campaign?.numberCount} /></Field>
    <Field id={`${prefix}-product`} label="Produto vinculado"><select className="g-input" id={`${prefix}-product`} name="productId" required defaultValue={campaign?.productId ?? ""}><option value="" disabled>Selecione um produto</option>{products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
    <Field id={`${prefix}-location`} label="Localização central"><select className="g-input" id={`${prefix}-location`} name="locationId" required defaultValue={campaign?.locationId ?? ""}><option value="" disabled>Selecione uma localização</option>{locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
    <Field id={`${prefix}-start`} label="Início (horário deste dispositivo)"><Input id={`${prefix}-start`} name="startsAt" type="datetime-local" required defaultValue={campaign ? toLocalInput(campaign.startsAt) : undefined} /></Field>
    <Field id={`${prefix}-end`} label="Encerramento (horário deste dispositivo)"><Input id={`${prefix}-end`} name="endsAt" type="datetime-local" required defaultValue={campaign ? toLocalInput(campaign.endsAt) : undefined} /></Field>
    {campaign && <Field id={`${prefix}-description`} label="Descrição para os compradores (opcional)" className="sm:col-span-2"><Input id={`${prefix}-description`} name="description" maxLength={1000} defaultValue={campaign.description ?? ""} /></Field>}
  </>;
}

const buyerStatus: Record<AdminRaffleBuyer["status"], { label: string; tone: "warning" | "success" | "neutral" }> = {
  RESERVED: { label: "Aguardando pagamento", tone: "warning" }, PAID: { label: "Pago", tone: "success" }, REFUNDED: { label: "Estornado", tone: "neutral" },
};

/** Spec 5.11 / 15.5 (RAF-006): buyers and contacts, loaded only when a manager opens the list. */
function RaffleBuyers({ campaign }: { campaign: AdminRaffleCampaign }) {
  const [buyers, setBuyers] = useState<AdminRaffleBuyer[] | null>(null);
  const [error, setError] = useState("");
  async function load() {
    setError("");
    try {
      const response = await fetch(`/api/v1/admin/raffles/${campaign.campaignId}/buyers`, { cache: "no-store" });
      const parsed = adminRaffleBuyersResponseSchema.safeParse(await response.json().catch(() => null));
      if (!response.ok || !parsed.success) throw new Error("Não foi possível carregar os compradores.");
      setBuyers(parsed.data.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar os compradores."); }
  }
  return <details onToggle={(event) => { if (event.currentTarget.open && buyers === null) void load(); }}>
    <summary className="min-h-11 cursor-pointer py-3 font-semibold">Compradores</summary>
    {error ? <p role="alert" className="text-sm text-[var(--g-status-danger-foreground)]">{error}</p>
      : buyers === null ? <p role="status" className="text-sm">Carregando compradores…</p>
      : buyers.length === 0 ? <p className="text-sm text-[var(--g-text-secondary)]">Nenhum número vendido ainda.</p>
      : <ul aria-label={`Compradores de ${campaign.name}`} className="divide-y divide-[var(--g-border-subtle)] text-sm">{buyers.map((buyer) => <li key={buyer.saleId} aria-label={`Números ${buyer.numbers.join(", ")}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
        <div><p className="font-semibold">{buyer.numbers.join(", ")} · {buyer.buyerName ?? "Comprador"}{buyer.won && <Badge tone="success" className="ml-2">Ganhador</Badge>}</p>
          <p className="text-[var(--g-text-secondary)]">{buyer.buyerContact ?? "Sem contato"} · {buyer.registered ? "com cadastro" : "sem cadastro"} · {buyer.channel === "PDV" ? `PDV${buyer.sellerName ? ` (${buyer.sellerName})` : ""}` : "Portal"} · {money.format(buyer.totalCents / 100)}</p></div>
        <Badge tone={buyerStatus[buyer.status].tone}>{buyerStatus[buyer.status].label}</Badge>
      </li>)}</ul>}
  </details>;
}
