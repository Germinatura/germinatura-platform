"use client";

import { raffleCampaignCreateRequestSchema, raffleCampaignResponseSchema, raffleDrawResponseSchema } from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, Ticket } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

interface Campaign { id: string; name: string; number_count: number; status: "ACTIVE" | "CLOSED" | "DRAWN" | "CANCELLED"; starts_at: string; ends_at: string; }
interface Draw { campaign_id: string; winner_number: number; winner_index: number; eligible_numbers: number[]; random_material: string; audit_hash: string; }
interface Option { id: string; name: string; }
interface Props { campaigns: Campaign[]; draws: Draw[]; products: Option[]; locations: Option[]; enabled: boolean; unavailable: boolean; }
const labels = { ACTIVE: "Aberta", CLOSED: "Encerrada", DRAWN: "Sorteada", CANCELLED: "Cancelada" };
const date = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });

export function RafflesManager({ campaigns, draws, products, locations, enabled, unavailable }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [confirmation, setConfirmation] = useState<{ campaign: Campaign; action: "close" | "draw" } | null>(null);
  const lock = useRef(false);
  const keys = useRef(new Map<string, string>());
  const disabled = busy || unavailable || !enabled;

  async function perform(path: string, payload: unknown, action: "create" | "close" | "draw") {
    if (lock.current || unavailable || !enabled) return false;
    if (!navigator.onLine) { setError("Sem internet. Reconecte antes de alterar uma campanha ou realizar um sorteio."); return false; }
    lock.current = true; setBusy(true); setError(""); setMessage("");
    const fingerprint = JSON.stringify([path, payload]);
    const key = keys.current.get(fingerprint) ?? `raffle-${action}:${crypto.randomUUID()}`;
    keys.current.set(fingerprint, key);
    try {
      const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(payload) });
      const body: unknown = await response.json();
      if (!response.ok) {
        const detail = body as { message?: unknown };
        throw new Error(typeof detail?.message === "string" ? detail.message : "Não foi possível concluir. Recarregue os dados antes de tentar novamente.");
      }
      const valid = action === "draw" ? raffleDrawResponseSchema.safeParse(body).success : raffleCampaignResponseSchema.safeParse(body).success;
      if (!valid) throw new Error("O servidor retornou uma resposta inesperada. Recarregue os dados antes de tentar novamente.");
      setMessage(action === "create" ? "Campanha criada e auditada." : action === "close" ? "Campanha encerrada. Novas reservas estão bloqueadas." : "Sorteio registrado. O resultado é único e não pode ser repetido.");
      setConfirmation(null); router.refresh(); return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir. Tente novamente com a mesma operação."); return false;
    } finally { lock.current = false; setBusy(false); }
  }

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const start = new Date(String(values.get("startsAt")));
    const end = new Date(String(values.get("endsAt")));
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) { setError("Informe datas válidas para início e encerramento."); return; }
    const parsed = raffleCampaignCreateRequestSchema.safeParse({ name: values.get("name"), productId: values.get("productId"), locationId: values.get("locationId"), numberCount: Number(values.get("numberCount")), startsAt: start.toISOString(), endsAt: end.toISOString() });
    if (!parsed.success) { setError("Revise os campos: use de 1 a 10.000 números e um encerramento posterior ao início."); return; }
    if (await perform("/api/v1/admin/raffles", parsed.data, "create")) form.reset();
  }

  const filtered = campaigns.filter((item) => item.name.toLocaleLowerCase("pt-BR").includes(query.trim().toLocaleLowerCase("pt-BR")));
  return <div className="px-4 py-8 sm:px-6 lg:px-8"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header><h1 className="text-3xl font-bold">Gestão de rifas</h1><p className="mt-2 text-[var(--g-text-secondary)]">Crie campanhas, encerre reservas e consulte o resultado auditável. Apenas números pagos participam do sorteio.</p></header>
    {(unavailable || !enabled) && <Card className="flex gap-3 p-4"><AlertTriangle className="size-5 shrink-0" /><p role="alert">{unavailable ? "Não foi possível carregar os dados. Recarregue a página; as ações estão bloqueadas." : "Rifas estão desabilitadas. As ações permanecem bloqueadas pela flag."}</p></Card>}
    {message && <p role="status" className="rounded-[var(--g-radius-control)] bg-[var(--g-status-success-soft)] p-4 text-[var(--g-status-success-foreground)]">{message}</p>}
    <Card className="p-5"><details><summary className="min-h-11 cursor-pointer py-3 font-semibold">Nova campanha</summary>
      <p className="mb-4 text-sm text-[var(--g-text-secondary)]">O preço de cada número será calculado pelo servidor a partir do produto vinculado. Esta tela não confirma pagamentos.</p>
      {(!products.length || !locations.length) && <p className="mb-4 text-sm">É necessário um produto ativo e publicado e uma localização central ativa.</p>}
      <form onSubmit={create}><fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2">
        <Field id="raffle-name" label="Nome da campanha"><Input id="raffle-name" name="name" required maxLength={160} /></Field>
        <Field id="raffle-count" label="Quantidade de números"><Input id="raffle-count" name="numberCount" type="number" required min={1} max={10000} step={1} /></Field>
        <Field id="raffle-product" label="Produto vinculado"><select className="g-input" id="raffle-product" name="productId" required defaultValue=""><option value="" disabled>Selecione um produto</option>{products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
        <Field id="raffle-location" label="Localização central"><select className="g-input" id="raffle-location" name="locationId" required defaultValue=""><option value="" disabled>Selecione uma localização</option>{locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
        <Field id="raffle-start" label="Início (horário deste dispositivo)"><Input id="raffle-start" name="startsAt" type="datetime-local" required /></Field>
        <Field id="raffle-end" label="Encerramento (horário deste dispositivo)"><Input id="raffle-end" name="endsAt" type="datetime-local" required /></Field>
        <Button type="submit" loading={busy} disabled={disabled || !products.length || !locations.length}>Criar campanha</Button>
      </fieldset>{error && !confirmation && <p role="alert" className="mt-4 text-[var(--g-status-danger-foreground)]">{error}</p>}</form>
    </details></Card>
    <section className="space-y-4" aria-label="Campanhas de rifas"><div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-xl font-semibold">Campanhas recentes</h2><p className="text-sm text-[var(--g-text-secondary)]">Até 50 campanhas mais recentes. Seletores mostram até 200 opções.</p></div><Field id="raffle-search" label="Buscar campanha"><Input id="raffle-search" value={query} onChange={(event) => setQuery(event.target.value)} /></Field></div>
      {!unavailable && !filtered.length && <Card className="p-8 text-center"><Ticket className="mx-auto size-8" /><h3 className="mt-3 font-semibold">Nenhuma campanha encontrada</h3><p className="mt-2 text-sm">Crie uma campanha ou ajuste a busca.</p></Card>}
      {!unavailable && filtered.map((campaign) => {
        const draw = draws.find((item) => item.campaign_id === campaign.id);
        const selected = confirmation?.campaign.id === campaign.id;
        return <Card key={campaign.id} className="space-y-4 p-5"><div className="flex items-start justify-between gap-3"><div><h3 className="text-lg font-semibold">{campaign.name}</h3><p className="mt-1 text-sm text-[var(--g-text-secondary)]">{campaign.number_count} números · {date.format(new Date(campaign.starts_at))} até {date.format(new Date(campaign.ends_at))} (Brasília)</p></div><Badge tone={campaign.status === "DRAWN" ? "success" : "neutral"}>{labels[campaign.status]}</Badge></div>
          {draw && <div className="space-y-3"><p className="text-xl font-bold">Número vencedor: {draw.winner_number}</p><details><summary className="min-h-11 cursor-pointer py-3 font-semibold">Evidências do sorteio</summary><dl className="space-y-3 break-all text-sm"><div><dt className="font-semibold">Números elegíveis (ordenados)</dt><dd>{draw.eligible_numbers.join(", ")}</dd></div><div><dt className="font-semibold">Índice vencedor (base 1)</dt><dd>{draw.winner_index}</dd></div><div><dt className="font-semibold">Material aleatório</dt><dd>{draw.random_material}</dd></div><div><dt className="font-semibold">Hash de auditoria</dt><dd>{draw.audit_hash}</dd></div></dl></details></div>}
          {campaign.status === "ACTIVE" && <Button disabled={disabled} variant="secondary" onClick={() => { setError(""); setConfirmation({ campaign, action: "close" }); }}>Encerrar reservas</Button>}
          {campaign.status === "CLOSED" && <Button disabled={disabled} onClick={() => { setError(""); setConfirmation({ campaign, action: "draw" }); }}>Preparar sorteio</Button>}
          {selected && <section aria-label="Confirmar operação" className="space-y-3 rounded-[var(--g-radius-control)] bg-[var(--g-status-warning-soft)] p-4"><p className="text-sm text-[var(--g-status-warning-foreground)]">{confirmation.action === "draw" ? "O sorteio será executado uma única vez no servidor, somente entre números pagos. Não é possível escolher ou repetir o resultado." : "O encerramento impede novas reservas. Se houver reservas pendentes, o servidor recusará a operação."}</p><div className="flex flex-wrap gap-3"><Button disabled={disabled} loading={busy} onClick={() => void perform(`/api/v1/admin/raffles/${campaign.id}/${confirmation.action}`, {}, confirmation.action)}>{confirmation.action === "draw" ? "Confirmar sorteio único" : "Confirmar encerramento"}</Button><Button variant="secondary" disabled={busy} onClick={() => setConfirmation(null)}>Cancelar</Button></div></section>}
          {selected && error && <p role="alert" className="text-[var(--g-status-danger-foreground)]">{error}</p>}
        </Card>;
      })}
    </section>
  </div></div>;
}
