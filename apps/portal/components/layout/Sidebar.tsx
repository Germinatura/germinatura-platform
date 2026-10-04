"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useSyncExternalStore, type KeyboardEvent } from "react";
import { ChevronDown, PanelLeftClose, PanelLeftOpen, Search, UserRoundCog, X } from "lucide-react";
import { experienceHome, type PortalExperience } from "@/lib/portal-experience";
import { activeSection, navigationFor, type NavigationItem } from "@/lib/navigation";
import { BrandMark } from "@/components/brand/BrandMark";
import { useCollapsedSections } from "./navigation-state";

export interface SidebarUser { nome: string; perfil: string; roles: string[]; avatarUrl?: string | null; }
interface SidebarProps {
  user: SidebarUser | null;
  experience?: PortalExperience;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onNavigate?: () => void;
  onOpenSearch?: () => void;
  enabledFeatures?: string[];
}

export const pdvUrl = process.env.NEXT_PUBLIC_PDV_URL ?? "http://127.0.0.1:3001";
const subscribeNothing = () => () => {};

export function Sidebar({ user, experience = "admin", collapsed = false, onToggleCollapsed, onNavigate, onOpenSearch, enabledFeatures = [] }: SidebarProps) {
  const pathname = usePathname();
  const baseId = useId();
  const roles = useMemo(() => user?.roles ?? [], [user]);
  const hasAdminRole = roles.includes("ADMIN");
  const isAdmin = hasAdminRole && experience === "admin";
  const home = isAdmin ? "/" : "/inicio";
  const sections = useMemo(() => navigationFor({ roles, experience, features: enabledFeatures, pdvUrl }), [roles, experience, enabledFeatures]);
  const currentSection = activeSection(sections, pathname);
  const { collapsed: collapsedSections, setCollapsed } = useCollapsedSections();
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const openedFor = useRef<string | null>(null);

  // Arriving at a route opens its section once; the person may collapse it again afterwards.
  useEffect(() => {
    if (!hydrated || !currentSection || openedFor.current === pathname) return;
    openedFor.current = pathname;
    if (collapsedSections.has(currentSection)) setCollapsed(currentSection, false);
  }, [hydrated, pathname, currentSection, collapsedSections, setCollapsed]);

  const itemClass = (active: boolean) => [
    "group relative flex min-h-11 items-center rounded-[var(--g-radius-control)] text-sm font-semibold transition-colors",
    collapsed ? "justify-center px-2" : "gap-3 px-3",
    active ? "bg-[var(--g-brand-primary-soft)] text-[var(--g-brand-primary)]" : "text-[var(--g-text-secondary)] hover:bg-[var(--g-surface-hover)] hover:text-[var(--g-brand-primary)]",
  ].join(" ");

  function renderItem(item: NavigationItem) {
    const active = item.active(pathname);
    const Icon = item.icon;
    return (
      <Link key={item.id} href={item.href} onClick={item.external ? undefined : onNavigate} className={itemClass(active)} title={collapsed ? item.label : undefined} aria-current={active ? "page" : undefined}>
        {active && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-[var(--g-accent-aqua)]" />}
        <Icon className="size-5 shrink-0" />{!collapsed && <span>{item.label}</span>}
      </Link>
    );
  }

  // WAI-ARIA accordion: arrows, Home and End move between section headers.
  function moveBetweenHeaders(event: KeyboardEvent<HTMLButtonElement>) {
    const headers = Array.from(event.currentTarget.closest("nav")?.querySelectorAll<HTMLButtonElement>("[data-nav-section-toggle]") ?? []);
    const index = headers.indexOf(event.currentTarget);
    const target = event.key === "ArrowDown" ? headers[(index + 1) % headers.length]
      : event.key === "ArrowUp" ? headers[(index - 1 + headers.length) % headers.length]
      : event.key === "Home" ? headers[0]
      : event.key === "End" ? headers[headers.length - 1]
      : undefined;
    if (!target) return;
    event.preventDefault();
    target.focus();
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col border-r border-[var(--g-border-subtle)] bg-[var(--g-surface-default)]">
      <div className={`flex min-h-[76px] shrink-0 items-center ${collapsed ? "justify-center px-3" : "justify-between gap-3 px-5"}`}>
        <Link href={home} onClick={onNavigate} className="flex min-w-0 items-center gap-3" aria-label="Germinatura — Início">
          <BrandMark className="size-10 shrink-0" />
          {!collapsed && <span className="truncate text-base font-semibold text-[var(--g-brand-primary-dark)]">Germinatura</span>}
        </Link>
        {onNavigate && <button type="button" onClick={onNavigate} className="flex size-11 items-center justify-center rounded-[var(--g-radius-control)] text-[var(--g-text-muted)] hover:bg-[var(--g-surface-hover)]" aria-label="Fechar navegação"><X className="size-5" /></button>}
      </div>

      {hasAdminRole && <Link href={experienceHome(isAdmin ? "consumer" : "admin")} onClick={onNavigate} title={isAdmin ? "Visão do consumidor" : "Visão administrativa"} className="mx-3 mb-2 flex min-h-11 shrink-0 items-center justify-center rounded-lg border border-[var(--g-border-default)] px-3 text-sm font-semibold text-[var(--g-brand-primary)]">
        {collapsed ? <UserRoundCog className="size-5" /> : isAdmin ? "Visão do consumidor" : "Visão administrativa"}
      </Link>}
      {onOpenSearch && user && (
        <button type="button" onClick={onOpenSearch} title={collapsed ? "Pesquisar no menu (Ctrl+K)" : undefined} aria-keyshortcuts="Control+K Meta+K" className={`mx-3 mb-1 flex min-h-11 shrink-0 items-center rounded-[var(--g-radius-control)] border border-[var(--g-border-subtle)] text-sm text-[var(--g-text-muted)] hover:bg-[var(--g-surface-hover)] ${collapsed ? "justify-center px-2" : "gap-3 px-3"}`}>
          <Search className="size-5 shrink-0" />
          {collapsed ? <span className="sr-only">Pesquisar no menu</span> : <><span className="flex-1 text-left">Pesquisar no menu</span><kbd className="rounded border border-[var(--g-border-default)] px-1.5 text-xs font-semibold">Ctrl K</kbd></>}
        </button>
      )}
      <nav data-testid="sidebar-scroll-container" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4" aria-label="Navegação principal">
        {collapsed ? (
          // Fully collapsed sidebar: icons only, every section listed as before.
          <div className="space-y-1">{sections.flatMap((section) => section.items.filter((item) => !item.searchOnly).map(renderItem))}</div>
        ) : sections.map((section, index) => {
          const items = section.items.filter((item) => !item.searchOnly);
          const expanded = !collapsedSections.has(section.id);
          const headerId = `${baseId}-${section.id}-header`;
          const panelId = `${baseId}-${section.id}-items`;
          // A collapsed section still shows its active route, so the current page is never hidden.
          const shown = expanded ? items : items.filter((item) => item.active(pathname));
          return (
            <div key={section.id} className={index === 0 ? "" : "mt-4"}>
              <button type="button" id={headerId} data-nav-section-toggle aria-expanded={expanded} aria-controls={panelId} onClick={() => setCollapsed(section.id, expanded)} onKeyDown={moveBetweenHeaders} className="flex min-h-9 w-full items-center justify-between rounded-[var(--g-radius-control)] px-3 text-xs font-semibold uppercase tracking-wider text-[var(--g-text-muted)] hover:bg-[var(--g-surface-hover)] hover:text-[var(--g-text-secondary)]">
                <span>{section.label}</span>
                <ChevronDown aria-hidden className={`size-4 transition-transform ${expanded ? "" : "-rotate-90"}`} />
              </button>
              <div id={panelId} className="mt-1 space-y-1">{shown.map(renderItem)}</div>
            </div>
          );
        })}
      </nav>

      {onToggleCollapsed && (
        <div className="shrink-0 border-t border-[var(--g-border-subtle)] p-3">
          <button type="button" onClick={onToggleCollapsed} className={`flex min-h-11 w-full items-center rounded-[var(--g-radius-control)] text-sm font-semibold text-[var(--g-text-secondary)] hover:bg-[var(--g-surface-hover)] ${collapsed ? "justify-center" : "gap-3 px-3"}`} aria-label={collapsed ? "Expandir sidebar" : "Recolher sidebar"}>
            {collapsed ? <PanelLeftOpen className="size-5" /> : <><PanelLeftClose className="size-5" /><span>Recolher menu</span></>}
          </button>
        </div>
      )}
    </div>
  );
}
