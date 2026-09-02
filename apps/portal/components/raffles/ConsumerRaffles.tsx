import { Badge, Card } from "@germinatura/ui";
import { CalendarClock, CircleAlert, Hash, Ticket, Trophy } from "lucide-react";

export interface ConsumerRaffle {
  id: string;
  name: string;
  productName: string;
  productSku: string | null;
  numberCount: number;
  status: "ACTIVE" | "CLOSED" | "DRAWN" | "CANCELLED";
  startsAt: string;
  endsAt: string;
  ownedNumbers: Array<{ number: number; status: "RESERVED" | "PAID"; saleId: string; expiresAt: string }>;
  draw: { winnerNumber: number; auditHash: string; createdAt: string } | null;
}

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const statusPresentation = {
  ACTIVE: { label: "Ativa", tone: "success" as const },
  CLOSED: { label: "Encerrada", tone: "warning" as const },
  DRAWN: { label: "Sorteada", tone: "info" as const },
  CANCELLED: { label: "Cancelada", tone: "danger" as const },
};

export function ConsumerRaffles({ raffles, enabled, unavailable }: { raffles: ConsumerRaffle[]; enabled: boolean; unavailable: boolean }) {
  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
        <header>
          <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Rifas</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Campanhas e meus números</h1>
          <p className="mt-2 max-w-2xl text-base leading-6 text-[var(--g-text-secondary)]">Acompanhe campanhas, números vinculados à sua conta e resultados auditáveis. Somente números pagos participam do sorteio.</p>
        </header>

        {!enabled && <div role="status" className="flex items-start gap-3 rounded-[var(--g-radius-control)] bg-[var(--g-status-warning-soft)] p-4 text-sm text-[var(--g-status-warning-foreground)]"><CircleAlert className="mt-0.5 size-5 shrink-0" /><span>As rifas estão temporariamente indisponíveis. Nenhuma nova participação pode ser iniciada.</span></div>}
        {unavailable && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-control)] bg-[var(--g-status-danger-soft)] p-4 text-sm text-[var(--g-status-danger-foreground)]"><CircleAlert className="mt-0.5 size-5 shrink-0" /><span>Não foi possível consultar as rifas. Atualize a página antes de tomar uma decisão.</span></div>}

        {!unavailable && raffles.length === 0 ? (
          <Card className="p-10 text-center"><Ticket className="mx-auto size-11 text-[var(--g-text-muted)]" /><h2 className="mt-4 text-lg font-semibold">Nenhuma campanha disponível</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--g-text-secondary)]">Quando uma rifa for publicada, ela aparecerá aqui com período, quantidade de números e resultado.</p></Card>
        ) : !unavailable && (
          <section className="grid gap-4" aria-label="Campanhas de rifa">
            {raffles.map((raffle) => {
              const presentation = statusPresentation[raffle.status];
              const paidNumbers = raffle.ownedNumbers.filter((item) => item.status === "PAID");
              const reservedNumbers = raffle.ownedNumbers.filter((item) => item.status === "RESERVED");
              const won = raffle.draw ? paidNumbers.some((item) => item.number === raffle.draw!.winnerNumber) : false;
              return <Card key={raffle.id} className="overflow-hidden">
                <div className="p-5 sm:p-6">
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><Badge tone={presentation.tone}>{presentation.label}</Badge>{won && <Badge tone="success">Você ganhou</Badge>}</div>
                      <h2 className="mt-3 text-xl font-bold text-[var(--g-text-primary)]">{raffle.name}</h2>
                      <p className="mt-1 text-sm text-[var(--g-text-secondary)]">{raffle.productName}{raffle.productSku ? ` · ${raffle.productSku}` : ""}</p>
                      <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
                        <div className="flex items-start gap-2"><Hash className="mt-0.5 size-4 shrink-0 text-[var(--g-brand-primary)]" /><div><dt className="text-[var(--g-text-muted)]">Numeração</dt><dd className="mt-0.5 font-semibold">1 a {raffle.numberCount}</dd></div></div>
                        <div className="flex items-start gap-2"><CalendarClock className="mt-0.5 size-4 shrink-0 text-[var(--g-brand-primary)]" /><div><dt className="text-[var(--g-text-muted)]">Período</dt><dd className="mt-0.5 font-semibold">{dateTime.format(new Date(raffle.startsAt))} até {dateTime.format(new Date(raffle.endsAt))}</dd></div></div>
                      </dl>
                    </div>
                    <div className="w-full rounded-[var(--g-radius-control)] bg-[var(--g-surface-subtle)] p-4 lg:w-80">
                      <h3 className="text-sm font-semibold">Meus números</h3>
                      {raffle.ownedNumbers.length === 0 ? <p className="mt-2 text-sm leading-5 text-[var(--g-text-secondary)]">Nenhum número vinculado à sua conta nesta campanha.</p> : <div className="mt-3 space-y-3">
                        {paidNumbers.length > 0 && <div><p className="text-xs font-semibold uppercase tracking-wide text-[var(--g-text-muted)]">Pagos e elegíveis</p><div className="mt-2 flex flex-wrap gap-2">{paidNumbers.map((item) => <span key={item.number} className="g-money inline-flex min-h-9 min-w-9 items-center justify-center rounded-full bg-[var(--g-status-success-soft)] px-2 text-sm font-bold text-[var(--g-status-success-foreground)]">{item.number}</span>)}</div></div>}
                        {reservedNumbers.length > 0 && <div><p className="text-xs font-semibold uppercase tracking-wide text-[var(--g-text-muted)]">Aguardando pagamento</p><div className="mt-2 flex flex-wrap gap-2">{reservedNumbers.map((item) => <span key={item.number} className="g-money inline-flex min-h-9 min-w-9 items-center justify-center rounded-full bg-[var(--g-status-warning-soft)] px-2 text-sm font-bold text-[var(--g-status-warning-foreground)]">{item.number}</span>)}</div><p className="mt-2 text-xs leading-5 text-[var(--g-text-secondary)]">A reserva expira no horário registrado e ainda não participa do sorteio.</p></div>}
                      </div>}
                    </div>
                  </div>
                </div>
                {raffle.draw && <div className="border-t border-[var(--g-border-subtle)] bg-[var(--g-brand-primary-soft)] px-5 py-4 sm:px-6"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-3"><Trophy className="size-5 text-[var(--g-brand-primary)]" /><div><p className="text-sm font-semibold">Número sorteado: <span className="g-money">{raffle.draw.winnerNumber}</span></p><p className="mt-0.5 text-xs text-[var(--g-text-secondary)]">Sorteio em {dateTime.format(new Date(raffle.draw.createdAt))}</p></div></div><p className="max-w-full truncate font-mono text-xs text-[var(--g-text-muted)]" title={raffle.draw.auditHash}>Hash: {raffle.draw.auditHash}</p></div></div>}
              </Card>;
            })}
          </section>
        )}

        {enabled && !unavailable && <p className="rounded-[var(--g-radius-control)] border border-[var(--g-border-subtle)] bg-[var(--g-surface-default)] p-4 text-sm leading-6 text-[var(--g-text-secondary)]">A escolha de novos números será liberada aqui quando a etapa de pagamento do consumidor estiver completa. A interface não considera uma reserva como pagamento confirmado.</p>}
      </div>
    </div>
  );
}
