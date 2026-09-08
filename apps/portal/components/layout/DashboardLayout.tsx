"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Sidebar, type SidebarUser } from "./Sidebar";
import { experienceForPath, type PortalExperience } from "@/lib/portal-experience";
import { Topbar } from "./Topbar";

const publicPaths = ["/login", "/esqueci-senha", "/recuperar-senha"];
const experienceEvent = "germinatura:experience-changed";
function subscribeExperience(callback: () => void) {
  window.addEventListener(experienceEvent, callback);
  return () => window.removeEventListener(experienceEvent, callback);
}
function savedExperience(): PortalExperience {
  return sessionStorage.getItem("portal-experience") === "consumer" ? "consumer" : "admin";
}
const serverExperience = (): PortalExperience => "admin";

function pageTitle(pathname: string, user: SidebarUser | null) {
  if (pathname === "/") return user?.roles.includes("ADMIN") ? "Visão geral" : "Início";
  if (pathname.startsWith("/admin/usuarios")) return "Usuários e vendedores";
  if (pathname.startsWith("/admin/catalogo")) return "Catálogo";
  if (pathname.startsWith("/admin/estoque")) return "Estoque";
  if (pathname.startsWith("/admin/rifas")) return "Gestão de rifas";
  if (pathname === "/inicio") return "Início";
  if (pathname === "/perfil") return "Perfil";
  if (pathname === "/catalogo") return "Catálogo";
  if (pathname === "/reservas") return "Minhas reservas";
  if (pathname === "/rifas") return "Rifas";
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
  const [profileRevision, setProfileRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setProfileRevision((value) => value + 1);
    window.addEventListener("germinatura:profile-updated", refresh);
    return () => window.removeEventListener("germinatura:profile-updated", refresh);
  }, []);
  const storedExperience = useSyncExternalStore(subscribeExperience, savedExperience, serverExperience);
  const experience = experienceForPath(pathname) ?? storedExperience;
  useEffect(() => {
    const fromPath = experienceForPath(pathname);
    if (fromPath) { sessionStorage.setItem("portal-experience", fromPath); window.dispatchEvent(new Event(experienceEvent)); }
  }, [pathname]);
  const [loading, setLoading] = useState(true);
  const [enabledFeatures, setEnabledFeatures] = useState<string[]>([]);
  const isPublic = publicPaths.includes(pathname) || pathname.startsWith("/cadastro") || pathname.startsWith("/pdv");

  useEffect(() => {
    if (isPublic) return;
    let active = true;
    Promise.all([
      fetch("/api/auth/me").then(async (response) => response.ok ? response.json() as Promise<{ user: SidebarUser }> : null),
      fetch("/api/v1/feature-flags").then(async (response) => response.ok ? response.json() as Promise<{ data: Array<{ key: string; enabled: boolean }> }> : null),
    ])
      .then(([data, flags]) => { if (active) { setUser(data?.user ?? null); setEnabledFeatures(flags?.data.filter((flag) => flag.enabled).map((flag) => flag.key) ?? []); } })
      .catch(() => { if (active) { setUser(null); setEnabledFeatures([]); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [isPublic, pathname, profileRevision]);

  if (isPublic) return <>{children}</>;

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex h-dvh min-h-0 overflow-hidden bg-[var(--g-surface-canvas)] text-[var(--g-text-primary)]">
      <aside className={`hidden h-full min-h-0 shrink-0 transition-[width] duration-200 lg:flex ${isCollapsed ? "w-[var(--g-sidebar-collapsed)]" : "w-[var(--g-sidebar-expanded)]"}`}>
        <Sidebar experience={experience} user={user} collapsed={isCollapsed} enabledFeatures={enabledFeatures} onToggleCollapsed={() => setIsCollapsed(!isCollapsed)} />
      </aside>

      {isSidebarOpen && <button type="button" className="fixed inset-0 z-40 bg-[var(--g-surface-overlay)] lg:hidden" onClick={() => setIsSidebarOpen(false)} aria-label="Fechar navegação" />}
      <div data-testid="mobile-sidebar" inert={!isSidebarOpen} className={`fixed inset-y-0 left-0 z-50 w-[min(var(--g-sidebar-expanded),calc(100vw-3rem))] transform bg-[var(--g-surface-default)] transition-transform duration-200 lg:hidden ${isSidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <Sidebar experience={experience} user={user} enabledFeatures={enabledFeatures} onNavigate={() => setIsSidebarOpen(false)} />
      </div>

      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar title={pageTitle(pathname, user)} user={user} loading={loading} onOpenMenu={() => setIsSidebarOpen(true)} onLogout={handleLogout} />
        <main data-testid="dashboard-scroll-container" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</main>
      </div>
    </div>
  );
}
