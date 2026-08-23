"use client";

import { useEffect, useState } from "react";
import { Loader2, LogOut, ShieldCheck, Store, Undo2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { getSupabaseBrowserClient } from "@/lib/supabase";

interface SessionUser {
  nome: string;
  perfil: string;
  roles: string[];
}

export default function PdvFoundation() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const portalUrl = process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://127.0.0.1:3000";

  useEffect(() => {
    apiFetch("/api/v1/auth/session")
      .then(async (response) => {
        if (!response.ok) throw new Error("Sessão inválida");
        return response.json() as Promise<{ user: SessionUser }>;
      })
      .then((data) => setUser(data.user))
      .catch(() => window.location.assign("/login"))
      .finally(() => setLoading(false));
  }, []);

  async function logout() {
    await getSupabaseBrowserClient().auth.signOut();
    window.location.assign(user?.perfil === "ADMIN" ? `${portalUrl}/login` : "/login");
  }

  if (loading) {
    return <main className="flex min-h-screen items-center justify-center bg-slate-950"><Loader2 className="size-8 animate-spin text-emerald-400" /></main>;
  }

  return (
    <main className="min-h-screen bg-slate-950 p-5 text-white md:p-10">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-5xl flex-col">
        <header className="flex items-center justify-between border-b border-white/10 pb-5">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-emerald-400 p-3 text-slate-950"><Store className="size-6" /></div>
            <div><h1 className="font-black">Germinatura PDV</h1><p className="text-xs text-slate-400">Fundação v2.1</p></div>
          </div>
          <button type="button" onClick={logout} className="flex items-center gap-2 rounded-xl border border-white/10 px-4 py-2 text-sm font-bold hover:bg-white/5">
            <LogOut className="size-4" /> Sair do PDV
          </button>
        </header>
        <section className="flex flex-1 items-center py-12">
          <div className="w-full rounded-[2rem] border border-white/10 bg-white/[0.04] p-8 md:p-12">
            <span className="inline-flex items-center gap-2 rounded-full bg-emerald-400/10 px-3 py-1 text-xs font-black uppercase tracking-widest text-emerald-300">
              <ShieldCheck className="size-4" /> Acesso autorizado
            </span>
            <h2 className="mt-6 text-3xl font-black md:text-5xl">Olá, {user?.nome}</h2>
            <p className="mt-4 max-w-2xl text-base leading-7 text-slate-300">
              O shell do PDV está pronto para validar autenticação e papéis. Vendas, estoque e pagamentos permanecem indisponíveis até a implementação dos contratos transacionais v2.
            </p>
            <div className="mt-8 flex flex-wrap gap-2">
              {user?.roles.map((role) => <span key={role} className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold text-slate-300">{role}</span>)}
            </div>
            <button type="button" title="Voltar ao Painel" onClick={() => window.location.assign(portalUrl)} className="mt-10 inline-flex items-center gap-2 rounded-2xl bg-emerald-400 px-5 py-3 font-black text-slate-950 hover:bg-emerald-300">
              <Undo2 className="size-5" /> Voltar ao Portal
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
