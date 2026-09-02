import Link from "next/link";
import { AlertTriangle, ArrowRight, CircleDollarSign, ClipboardCheck, ReceiptText, ShoppingBag, UsersRound } from "lucide-react";
import { Badge, Card } from "@germinatura/ui";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });

const statusLabels: Record<string, string> = {
  DRAFT: "Rascunho",
  AWAITING_PAYMENT: "Aguardando pagamento",
  CONFIRMED: "Confirmada",
  CANCELLED: "Cancelada",
};

function formatMoney(cents: number) {
  return money.format(cents / 100);
}

export async function AdminOverview({ name }: { name: string }) {
  const client = await createSupabaseServerClient();
  const [salesResult, pendingResult, divergentResult, closeoutResult] = await Promise.all([
    client.from("sales").select("id,status,total_cents,created_at,channel").order("created_at", { ascending: false }).limit(100),
    client.from("sales").select("id", { count: "exact", head: true }).eq("status", "AWAITING_PAYMENT"),
    client.from("payment_reconciliations").select("id", { count: "exact", head: true }).eq("outcome", "DIVERGENT"),
    client.from("seller_closeouts").select("id", { count: "exact", head: true }).eq("status", "REOPENED"),
  ]);
  const unavailable = Boolean(salesResult.error || pendingResult.error || divergentResult.error || closeoutResult.error);
  const sales = salesResult.data ?? [];
  const confirmed = sales.filter((sale) => sale.status === "CONFIRMED");
  const revenueCents = confirmed.reduce((total, sale) => total + Number(sale.total_cents), 0);
  const pendingCount = (pendingResult.count ?? 0) + (divergentResult.count ?? 0) + (closeoutResult.count ?? 0);
  const kpis = [
    { label: "Receita", value: formatMoney(revenueCents), hint: "nas últimas vendas registradas", icon: CircleDollarSign },
    { label: "Vendas", value: String(confirmed.length), hint: "confirmadas entre os 100 registros recentes", icon: ShoppingBag },
    { label: "Ticket médio", value: confirmed.length ? formatMoney(Math.round(revenueCents / confirmed.length)) : formatMoney(0), hint: "sobre vendas confirmadas", icon: ReceiptText },
    { label: "Pendências", value: String(pendingCount), hint: "pagamentos, divergências e reaberturas", icon: ClipboardCheck },
  ];

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <div className="mx-auto max-w-[var(--g-content-standard)] space-y-8">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Visão geral</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-[var(--g-text-primary)]">Olá, {name}</h1>
            <p className="mt-2 max-w-2xl text-base leading-6 text-[var(--g-text-secondary)]">Resumo da operação e dos pontos que precisam de atenção.</p>
          </div>
          <Link href="/admin/usuarios" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--g-radius-control)] bg-[var(--g-brand-primary)] px-4 text-sm font-semibold text-white hover:bg-[var(--g-brand-primary-hover)]">
            <UsersRound className="size-5" /> Gerenciar usuários
          </Link>
        </header>

        {unavailable && (
          <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-warning)] bg-[var(--g-status-warning-soft)] p-4 text-[var(--g-status-warning-foreground)]">
            <AlertTriangle className="mt-0.5 size-5 shrink-0" />
            <div><p className="font-semibold">Parte do resumo está indisponível</p><p className="mt-1 text-sm">Atualize a página. Os valores abaixo não devem ser usados para fechamento enquanto este aviso estiver visível.</p></div>
          </div>
        )}

        <section aria-label="Indicadores da operação recente" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {kpis.map(({ label, value, hint, icon: Icon }) => (
            <Card key={label} className="p-5">
              <div className="flex items-start justify-between gap-4"><p className="text-sm font-semibold text-[var(--g-text-secondary)]">{label}</p><span className="flex size-10 items-center justify-center rounded-[var(--g-radius-control)] bg-[var(--g-brand-primary-soft)] text-[var(--g-brand-primary)]"><Icon className="size-5" /></span></div>
              <p className="g-money mt-5 text-3xl font-bold tracking-tight text-[var(--g-text-primary)]">{unavailable ? "—" : value}</p>
              <p className="mt-2 text-xs text-[var(--g-text-muted)]">{hint}</p>
            </Card>
          ))}
        </section>

        <section className="grid gap-4 lg:grid-cols-[0.75fr_1.25fr]">
          <Card className="p-6">
            <h2 className="text-lg font-bold text-[var(--g-text-primary)]">Alertas e divergências</h2>
            <p className="mt-1 text-sm text-[var(--g-text-secondary)]">Itens que exigem decisão operacional.</p>
            <div className="mt-5 space-y-3">
              {unavailable ? <p className="text-sm text-[var(--g-text-secondary)]">Não foi possível consultar as pendências agora.</p> : pendingCount === 0 ? (
                <div className="rounded-[var(--g-radius-control)] bg-[var(--g-status-success-soft)] p-4 text-sm text-[var(--g-status-success-foreground)]"><p className="font-semibold">Nenhuma pendência aberta</p><p className="mt-1">Pagamentos, conciliações e fechamentos estão sem alertas.</p></div>
              ) : (
                <>
                  <AlertRow label="Pagamentos aguardando confirmação" value={pendingResult.count ?? 0} />
                  <AlertRow label="Conciliações divergentes" value={divergentResult.count ?? 0} />
                  <AlertRow label="Fechamentos reabertos" value={closeoutResult.count ?? 0} />
                </>
              )}
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-[var(--g-border-subtle)] px-6 py-5"><h2 className="text-lg font-bold text-[var(--g-text-primary)]">Atividade recente</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">Últimas vendas registradas na plataforma.</p></div>
            {unavailable ? <p className="p-6 text-sm text-[var(--g-text-secondary)]">A atividade recente não está disponível.</p> : sales.length === 0 ? <p className="p-6 text-sm text-[var(--g-text-secondary)]">Ainda não há vendas neste período.</p> : (
              <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-[var(--g-surface-subtle)] text-xs uppercase tracking-wide text-[var(--g-text-muted)]"><tr><th className="px-6 py-3 font-semibold">Horário</th><th className="px-6 py-3 font-semibold">Canal</th><th className="px-6 py-3 font-semibold">Status</th><th className="px-6 py-3 text-right font-semibold">Total</th></tr></thead><tbody className="divide-y divide-[var(--g-border-subtle)]">{sales.slice(0, 8).map((sale) => <tr key={sale.id} className="hover:bg-[var(--g-surface-hover)]"><td className="whitespace-nowrap px-6 py-4 text-[var(--g-text-secondary)]">{dateTime.format(new Date(sale.created_at))}</td><td className="px-6 py-4 text-[var(--g-text-secondary)]">{sale.channel === "PDV" ? "PDV" : "Portal"}</td><td className="px-6 py-4"><Badge tone={sale.status === "CONFIRMED" ? "success" : sale.status === "CANCELLED" ? "danger" : "warning"}>{statusLabels[sale.status] ?? sale.status}</Badge></td><td className="g-money whitespace-nowrap px-6 py-4 text-right font-semibold">{formatMoney(Number(sale.total_cents))}</td></tr>)}</tbody></table></div>
            )}
          </Card>
        </section>
      </div>
    </div>
  );
}

function AlertRow({ label, value }: { label: string; value: number }) {
  return <div className="flex min-h-12 items-center justify-between gap-4 rounded-[var(--g-radius-control)] border border-[var(--g-border-subtle)] px-4"><span className="text-sm text-[var(--g-text-secondary)]">{label}</span><span className="flex items-center gap-2 font-semibold text-[var(--g-text-primary)]">{value}<ArrowRight className="size-4 text-[var(--g-text-muted)]" /></span></div>;
}
