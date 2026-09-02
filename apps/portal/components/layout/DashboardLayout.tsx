"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Sidebar, type SidebarUser } from "./Sidebar";
import { Topbar } from "./Topbar";

const publicPaths = ["/login", "/esqueci-senha", "/recuperar-senha"];

function pageTitle(pathname: string, user: SidebarUser | null) {
  if (pathname === "/") return user?.roles.includes("ADMIN") ? "Visão geral" : "Início";
  if (pathname.startsWith("/admin/usuarios")) return "Usuários e vendedores";
  if (pathname.startsWith("/admin/catalogo")) return "Catálogo";
  if (pathname.startsWith("/admin/estoque")) return "Estoque";
  if (pathname === "/trocar-senha") return "Perfil e segurança";
  if (pathname.startsWith("/notificacoes")) return "Notificações";
  return "Germinatura";
}

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [user, setUser] = useState<SidebarUser | null>(null);
  const [loading, setLoading] = useState(true);
  const isPublic = publicPaths.includes(pathname) || pathname.startsWith("/cadastro") || pathname.startsWith("/pdv");

  useEffect(() => {
    if (isPublic) return;
    let active = true;
    fetch("/api/auth/me")
      .then(async (response) => response.ok ? response.json() as Promise<{ user: SidebarUser }> : null)
      .then((data) => { if (active) setUser(data?.user ?? null); })
      .catch(() => { if (active) setUser(null); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [isPublic, pathname]);

  if (isPublic) return <>{children}</>;

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen bg-[var(--g-surface-canvas)] text-[var(--g-text-primary)]">
      <aside className={`sticky top-0 hidden h-screen shrink-0 transition-[width] duration-200 lg:flex ${isCollapsed ? "w-[var(--g-sidebar-collapsed)]" : "w-[var(--g-sidebar-expanded)]"}`}>
        <Sidebar user={user} loading={loading} collapsed={isCollapsed} onToggleCollapsed={() => setIsCollapsed(!isCollapsed)} onLogout={handleLogout} />
      </aside>

      {isSidebarOpen && <button type="button" className="fixed inset-0 z-40 bg-[var(--g-surface-overlay)] lg:hidden" onClick={() => setIsSidebarOpen(false)} aria-label="Fechar navegação" />}
      <div className={`fixed inset-y-0 left-0 z-50 w-[min(var(--g-sidebar-expanded),calc(100vw-3rem))] transform bg-[var(--g-surface-default)] transition-transform duration-200 lg:hidden ${isSidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <Sidebar user={user} loading={loading} onNavigate={() => setIsSidebarOpen(false)} onLogout={handleLogout} />
      </div>

      <div className="flex h-screen min-w-0 flex-1 flex-col">
        <Topbar title={pageTitle(pathname, user)} user={user} loading={loading} onOpenMenu={() => setIsSidebarOpen(true)} onLogout={handleLogout} />
        <main data-testid="dashboard-scroll-container" className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
