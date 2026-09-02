"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Boxes, CalendarClock, LayoutDashboard, PackageSearch, PanelLeftClose, PanelLeftOpen, ShieldCheck, ShoppingBag, Store, Ticket, UserRoundCog, X } from "lucide-react";
import { BrandMark } from "@/components/brand/BrandMark";

export interface SidebarUser { nome: string; perfil: string; roles: string[]; }
interface SidebarProps {
  user: SidebarUser | null;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onNavigate?: () => void;
  enabledFeatures?: string[];
}

export function Sidebar({ user, collapsed = false, onToggleCollapsed, onNavigate, enabledFeatures = [] }: SidebarProps) {
  const pathname = usePathname();
  const pdvUrl = process.env.NEXT_PUBLIC_PDV_URL ?? "http://127.0.0.1:3001";
  const canAccessPdv = user?.roles.some((role) => role === "ADMIN" || role === "VENDEDOR") ?? false;
  const isAdmin = user?.roles.includes("ADMIN") ?? false;
  const canInspectInventory = user?.roles.some((role) => role === "ADMIN" || role === "ESTOQUE") ?? false;
  const canBrowseCatalog = !isAdmin && (user?.roles.some((role) => role === "CONSUMIDOR" || role === "VENDEDOR" || role === "ESTOQUE") ?? false);
  const canManageOwnReservations = !isAdmin && (user?.roles.some((role) => role === "CONSUMIDOR" || role === "VENDEDOR") ?? false);
  const canBrowseRaffles = !isAdmin && enabledFeatures.includes("raffles") && (user?.roles.includes("CONSUMIDOR") ?? false);
  const itemClass = (active: boolean) => [
    "group relative flex min-h-11 items-center rounded-[var(--g-radius-control)] text-sm font-semibold transition-colors",
    collapsed ? "justify-center px-2" : "gap-3 px-3",
    active ? "bg-[var(--g-brand-primary-soft)] text-[var(--g-brand-primary)]" : "text-[var(--g-text-secondary)] hover:bg-[var(--g-surface-hover)] hover:text-[var(--g-brand-primary)]",
  ].join(" ");

  return (
    <div className="flex h-full w-full flex-col border-r border-[var(--g-border-subtle)] bg-[var(--g-surface-default)]">
      <div className={`flex min-h-[76px] items-center ${collapsed ? "justify-center px-3" : "justify-between gap-3 px-5"}`}>
        <Link href="/" onClick={onNavigate} className="flex min-w-0 items-center gap-3" aria-label="Germinatura — Início">
          <BrandMark className="size-10 shrink-0" />
          {!collapsed && <span className="truncate text-base font-semibold text-[var(--g-brand-primary-dark)]">Germinatura</span>}
        </Link>
        {onNavigate && <button type="button" onClick={onNavigate} className="flex size-11 items-center justify-center rounded-[var(--g-radius-control)] text-[var(--g-text-muted)] hover:bg-[var(--g-surface-hover)]" aria-label="Fechar navegação"><X className="size-5" /></button>}
      </div>

      <nav className="flex-1 space-y-1 px-3 py-4" aria-label="Navegação principal">
        {!collapsed && <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-[var(--g-text-muted)]">{isAdmin ? "Operação" : "Conta"}</p>}
        <Link href="/" onClick={onNavigate} className={itemClass(pathname === "/")} title={collapsed ? "Início" : undefined}>
          {pathname === "/" && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-[var(--g-accent-aqua)]" />}
          <LayoutDashboard className="size-5 shrink-0" />{!collapsed && <span>{isAdmin ? "Visão geral" : "Início"}</span>}
        </Link>
        {canBrowseCatalog && (
          <Link href="/catalogo" onClick={onNavigate} className={itemClass(pathname === "/catalogo")} title={collapsed ? "Catálogo" : undefined}>
            {pathname === "/catalogo" && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-[var(--g-accent-aqua)]" />}
            <ShoppingBag className="size-5 shrink-0" />{!collapsed && <span>Catálogo</span>}
          </Link>
        )}
        {canManageOwnReservations && (
          <Link href="/reservas" onClick={onNavigate} className={itemClass(pathname === "/reservas")} title={collapsed ? "Minhas reservas" : undefined}>
            {pathname === "/reservas" && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-[var(--g-accent-aqua)]" />}
            <CalendarClock className="size-5 shrink-0" />{!collapsed && <span>Minhas reservas</span>}
          </Link>
        )}
        {canBrowseRaffles && (
          <Link href="/rifas" onClick={onNavigate} className={itemClass(pathname === "/rifas")} title={collapsed ? "Rifas" : undefined}>
            {pathname === "/rifas" && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-[var(--g-accent-aqua)]" />}
            <Ticket className="size-5 shrink-0" />{!collapsed && <span>Rifas</span>}
          </Link>
        )}
        {isAdmin && (
          <Link href="/admin/usuarios" onClick={onNavigate} className={itemClass(pathname.startsWith("/admin/usuarios"))} title={collapsed ? "Usuários e vendedores" : undefined}>
            {pathname.startsWith("/admin/usuarios") && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-[var(--g-accent-aqua)]" />}
            <UserRoundCog className="size-5 shrink-0" />{!collapsed && <span>Usuários e vendedores</span>}
          </Link>
        )}
        {(isAdmin || canInspectInventory) && (
          <>
            {!collapsed && <p className="mb-2 mt-6 px-3 text-xs font-semibold uppercase tracking-wider text-[var(--g-text-muted)]">Catálogo e estoque</p>}
            {isAdmin && <Link href="/admin/catalogo" onClick={onNavigate} className={itemClass(pathname.startsWith("/admin/catalogo"))} title={collapsed ? "Catálogo" : undefined}>
              {pathname.startsWith("/admin/catalogo") && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-[var(--g-accent-aqua)]" />}
              <PackageSearch className="size-5 shrink-0" />{!collapsed && <span>Catálogo</span>}
            </Link>}
            {canInspectInventory && <Link href="/admin/estoque" onClick={onNavigate} className={itemClass(pathname.startsWith("/admin/estoque"))} title={collapsed ? "Estoque" : undefined}>
              {pathname.startsWith("/admin/estoque") && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-[var(--g-accent-aqua)]" />}
              <Boxes className="size-5 shrink-0" />{!collapsed && <span>Estoque</span>}
            </Link>}
          </>
        )}
        {!collapsed && <p className="mb-2 mt-6 px-3 text-xs font-semibold uppercase tracking-wider text-[var(--g-text-muted)]">Conta</p>}
        <Link href="/trocar-senha" onClick={onNavigate} className={itemClass(pathname === "/trocar-senha")} title={collapsed ? "Perfil e segurança" : undefined}>
          {pathname === "/trocar-senha" && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-[var(--g-accent-aqua)]" />}
          <ShieldCheck className="size-5 shrink-0" />{!collapsed && <span>Perfil e segurança</span>}
        </Link>
        {canAccessPdv && (
          <>
            {!collapsed && <p className="mb-2 mt-6 px-3 text-xs font-semibold uppercase tracking-wider text-[var(--g-text-muted)]">PDV</p>}
            <Link href={pdvUrl} className={itemClass(false)} title={collapsed ? "Abrir PDV" : undefined}><Store className="size-5 shrink-0" />{!collapsed && <span>Abrir PDV</span>}</Link>
          </>
        )}
      </nav>

      {onToggleCollapsed && (
        <div className="border-t border-[var(--g-border-subtle)] p-3">
          <button type="button" onClick={onToggleCollapsed} className={`flex min-h-11 w-full items-center rounded-[var(--g-radius-control)] text-sm font-semibold text-[var(--g-text-secondary)] hover:bg-[var(--g-surface-hover)] ${collapsed ? "justify-center" : "gap-3 px-3"}`} aria-label={collapsed ? "Expandir sidebar" : "Recolher sidebar"}>
            {collapsed ? <PanelLeftOpen className="size-5" /> : <><PanelLeftClose className="size-5" /><span>Recolher menu</span></>}
          </button>
        </div>
      )}
    </div>
  );
}
