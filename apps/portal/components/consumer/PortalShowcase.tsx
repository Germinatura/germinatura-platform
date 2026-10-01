"use client";

import { portalShowcaseResponseSchema, type PortalShowcase as Showcase } from "@germinatura/contracts";
import { Badge, Card } from "@germinatura/ui";
import { ArrowRight, CalendarDays, ExternalLink, MapPin, ShoppingBag, Sparkles, Tag, Ticket } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { eventWhen } from "@/components/events/PortalEvents";

const until = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

function CallToAction({ label, url }: { label: string; url: string }) {
  const className = "mt-4 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[var(--g-brand-primary)]";
  return url.startsWith("/")
    ? <Link href={url} className={className}>{label}<ArrowRight aria-hidden className="size-4" /></Link>
    : <a href={url} target="_blank" rel="noopener noreferrer" className={className}>{label}<ExternalLink aria-hidden className="size-4" /></a>;
}

function Section({ id, title, link, children }: { id: string; title: string; link?: { href: string; label: string }; children: React.ReactNode }) {
  return <section aria-labelledby={id} className="grid gap-3">
    <div className="flex items-end justify-between gap-3"><h3 id={id} className="text-xl font-bold text-[var(--g-text-primary)]">{title}</h3>
      {link && <Link href={link.href} className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-[var(--g-brand-primary)]">{link.label}<ArrowRight aria-hidden className="size-4" /></Link>}</div>
    {children}
  </section>;
}

/** Spec 4.1: the showcase of the class on the Início page. Sections without content are not shown. */
export function PortalShowcase() {
  const [showcase, setShowcase] = useState<Showcase | null>(null);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(async () => {
      const response = await fetch("/api/v1/showcase", { cache: "no-store" }).catch(() => null);
      const parsed = portalShowcaseResponseSchema.safeParse(await response?.json().catch(() => null));
      if (active && response?.ok && parsed.success) setShowcase(parsed.data.data);
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, []);
  if (!showcase) return null;
  return <div className="grid gap-8">
    {showcase.highlight && <Card aria-label="Destaque" className="relative overflow-hidden border-[var(--g-brand-primary)]/30 bg-[var(--g-brand-primary-soft)] p-6">
      <p className="flex items-center gap-2 text-sm font-semibold text-[var(--g-brand-primary)]"><Sparkles aria-hidden className="size-4" />Destaque</p>
      <h3 className="mt-2 text-2xl font-bold text-[var(--g-text-primary)]">{showcase.highlight.title}</h3>
      {showcase.highlight.message && <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--g-text-secondary)]">{showcase.highlight.message}</p>}
      {showcase.highlight.ctaLabel && showcase.highlight.ctaUrl && <CallToAction label={showcase.highlight.ctaLabel} url={showcase.highlight.ctaUrl} />}
    </Card>}

    {showcase.events.length > 0 && <Section id="showcase-events" title="Próximos eventos" link={{ href: "/eventos", label: "Ver todos" }}>
      <ul className="grid gap-4 md:grid-cols-3">{showcase.events.map((event) => <li key={event.id}><Card className="h-full p-5">
        <Badge tone="info">{event.kind === "CAMPANHA" ? "Campanha" : "Evento"}</Badge>
        <h4 className="mt-3 font-semibold"><Link href={`/eventos/${event.id}`} className="hover:underline">{event.title}</Link></h4>
        <p className="mt-2 flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><CalendarDays aria-hidden className="size-4 shrink-0" />{eventWhen(event)}</p>
        {event.location && <p className="mt-1 flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><MapPin aria-hidden className="size-4 shrink-0" />{event.location}</p>}
      </Card></li>)}</ul>
    </Section>}

    {showcase.promotions.length > 0 && <Section id="showcase-promotions" title="Promoções valendo" link={{ href: "/catalogo", label: "Ir ao catálogo" }}>
      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{showcase.promotions.map((promotion) => <li key={promotion.id}><Card className="h-full p-5">
        <p className="flex items-center gap-2 font-semibold"><Tag aria-hidden className="size-4 shrink-0 text-[var(--g-brand-primary)]" />{promotion.name}</p>
        {promotion.description && <p className="mt-2 line-clamp-2 text-sm text-[var(--g-text-secondary)]">{promotion.description}</p>}
        <p className="mt-2 text-xs text-[var(--g-text-muted)]">{promotion.validTo ? `Válida até ${until.format(new Date(promotion.validTo))}` : "Sem data para acabar"}</p>
      </Card></li>)}</ul>
    </Section>}

    {showcase.newProducts.length > 0 && <Section id="showcase-products" title="Novidades no catálogo" link={{ href: "/catalogo", label: "Ver catálogo" }}>
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{showcase.newProducts.map((product) => <li key={product.id}><Card className="h-full overflow-hidden">
        {product.imageUrl ? <div role="img" aria-label={product.imageAlt ?? product.name} className="h-32 bg-cover bg-center" style={{ backgroundImage: `url(${JSON.stringify(product.imageUrl)})` }} />
          : <div className="flex h-32 items-center justify-center bg-[var(--g-surface-subtle)]"><ShoppingBag aria-hidden className="size-10 text-[var(--g-brand-primary)]" /></div>}
        <div className="p-4"><p className="text-xs font-semibold uppercase tracking-wide text-[var(--g-text-muted)]">{product.category}</p><p className="mt-1 font-semibold">{product.name}</p></div>
      </Card></li>)}</ul>
    </Section>}

    {showcase.raffles.length > 0 && <Section id="showcase-raffles" title="Rifas à venda" link={{ href: "/rifas", label: "Ver rifas" }}>
      <ul className="grid gap-4 md:grid-cols-3">{showcase.raffles.map((raffle) => <li key={raffle.id}><Card className="h-full p-5">
        <p className="flex items-center gap-2 font-semibold"><Ticket aria-hidden className="size-4 shrink-0 text-[var(--g-brand-primary)]" />{raffle.name}</p>
        <p className="mt-2 text-sm text-[var(--g-text-secondary)]">{raffle.availableCount} de {raffle.numberCount} números livres</p>
        <p className="mt-1 text-xs text-[var(--g-text-muted)]">Vendas até {until.format(new Date(raffle.endsAt))}</p>
      </Card></li>)}</ul>
    </Section>}
  </div>;
}
