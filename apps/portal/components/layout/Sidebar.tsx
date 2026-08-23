"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { KeyRound, LayoutDashboard, Loader2, LogOut, Store } from "lucide-react";

interface User {
  nome: string;
  perfil: string;
  roles: string[];
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const pdvUrl = process.env.NEXT_PUBLIC_PDV_URL ?? "http://127.0.0.1:3001";

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me")
      .then(async (response) => response.ok ? response.json() as Promise<{ user: User }> : null)
      .then((data) => { if (active) setUser(data?.user ?? null); })
      .catch(() => { if (active) setUser(null); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [pathname]);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  if (pathname === "/login") return null;

  const canAccessPdv = user?.roles.some((role) => role === "ADMIN" || role === "VENDEDOR") ?? false;
  const itemClass = (active: boolean) => `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${active ? "bg-primary text-white shadow-md shadow-primary/20" : "text-slate-600 hover:bg-slate-50 hover:text-primary"}`;

  return (
    <aside className="flex h-full w-full flex-col border-r border-slate-200 bg-white">
      <div className="flex items-center gap-3 p-6">
        <img src="https://i.imgur.com/EnMI9CP.png" alt="Germinatura" className="size-10 rounded-lg" />
        <div>
          <h1 className="text-sm font-bold">Germinatura</h1>
          <p className="text-xs text-slate-500">Fundação v2.1</p>
        </div>
      </div>
      <nav className="flex-1 space-y-1 px-4 py-4" aria-label="Navegação principal">
        <Link href="/" className={itemClass(pathname === "/")}>
          <LayoutDashboard className="size-5" /> Fundação
        </Link>
        <Link href="/trocar-senha" className={itemClass(pathname === "/trocar-senha")}>
          <KeyRound className="size-5" /> Alterar senha
        </Link>
        {canAccessPdv && (
          <Link href={pdvUrl} className={itemClass(false)}>
            <Store className="size-5" /> Abrir PDV
          </Link>
        )}
      </nav>
      <div className="border-t border-slate-200 p-4">
        {loading ? (
          <div className="flex h-12 items-center justify-center"><Loader2 className="size-5 animate-spin text-primary" /></div>
        ) : (
          <button type="button" onClick={handleLogout} className="flex w-full items-center gap-3 rounded-xl p-2 text-left transition hover:bg-slate-50">
            <div className="flex size-10 items-center justify-center rounded-full border border-slate-200 bg-slate-100 font-bold text-slate-600">
              {user?.nome?.[0]?.toUpperCase() ?? "U"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-slate-900">{user?.nome ?? "Usuário"}</p>
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">{user?.perfil ?? "Acesso"}</p>
            </div>
            <LogOut className="size-4 text-slate-400" />
          </button>
        )}
      </div>
    </aside>
  );
}
