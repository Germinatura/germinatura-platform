"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, LogOut, PanelLeftClose, PanelLeftOpen, ShieldCheck, Store, X } from "lucide-react";
import { BrandMark } from "@/components/brand/BrandMark";

export interface SidebarUser { nome: string; perfil: string; roles: string[]; }
interface SidebarProps {
  user: SidebarUser | null;
  loading: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onNavigate?: () => void;
  onLogout: () => Promise<void>;
}

export function Sidebar({ user, loading, collapsed = false, onToggleCollapsed, onNavigate, onLogout }: SidebarProps) {
  const pathname = usePathname();
  const pdvUrl = process.env.NEXT_PUBLIC_PDV_URL ?? "http://127.0.0.1:3001";
  const canAccessPdv = user?.roles.some((role) => role === "ADMIN" || role === "VENDEDOR") ?? false;
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
        {!collapsed && <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-[var(--g-text-muted)]">Conta</p>}
        <Link href="/" onClick={onNavigate} className={itemClass(pathname === "/")} title={collapsed ? "Início" : undefined}>
          {pathname === "/" && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-[var(--g-accent-aqua)]" />}
          <Home className="size-5 shrink-0" />{!collapsed && <span>Início</span>}
        </Link>
        <Link href="/trocar-senha" onClick={onNavigate} className={itemClass(pathname === "/trocar-senha")} title={collapsed ? "Perfil e segurança" : undefined}>
          {pathname === "/trocar-senha" && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-[var(--g-accent-aqua)]" />}
          <ShieldCheck className="size-5 shrink-0" />{!collapsed && <span>Perfil e segurança</span>}
        </Link>
        {canAccessPdv && (
          <>
            {!collapsed && <p className="mb-2 mt-6 px-3 text-xs font-semibold uppercase tracking-wider text-[var(--g-text-muted)]">Operação</p>}
            <Link href={pdvUrl} className={itemClass(false)} title={collapsed ? "Abrir PDV" : undefined}><Store className="size-5 shrink-0" />{!collapsed && <span>Abrir PDV</span>}</Link>
          </>
        )}
      </nav>

      <div className="border-t border-[var(--g-border-subtle)] p-3">
        {!loading && (
          <div className={`flex items-center ${collapsed ? "justify-center" : "gap-3 px-2 py-2"}`}>
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--g-brand-primary-soft)] text-sm font-semibold text-[var(--g-brand-primary)]">{user?.nome?.[0]?.toUpperCase() ?? "U"}</span>
            {!collapsed && <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-[var(--g-text-primary)]">{user?.nome ?? "Usuário"}</p><p className="truncate text-xs text-[var(--g-text-muted)]">{user?.perfil ?? "Acesso"}</p></div>}
            {!collapsed && <button type="button" onClick={() => void onLogout()} className="flex size-11 items-center justify-center rounded-[var(--g-radius-control)] text-[var(--g-text-muted)] hover:bg-[var(--g-surface-hover)] hover:text-[var(--g-status-danger)]" aria-label="Sair da conta"><LogOut className="size-5" /></button>}
          </div>
        )}
        {onToggleCollapsed && (
          <button type="button" onClick={onToggleCollapsed} className={`mt-2 flex min-h-11 w-full items-center rounded-[var(--g-radius-control)] text-sm font-semibold text-[var(--g-text-secondary)] hover:bg-[var(--g-surface-hover)] ${collapsed ? "justify-center" : "gap-3 px-3"}`} aria-label={collapsed ? "Expandir sidebar" : "Recolher sidebar"}>
            {collapsed ? <PanelLeftOpen className="size-5" /> : <><PanelLeftClose className="size-5" /><span>Recolher menu</span></>}
          </button>
        )}
      </div>
    </div>
  );
}
