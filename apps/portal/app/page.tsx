import Link from "next/link";
import { Database, ShieldCheck, Store, Wrench } from "lucide-react";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

const roleLabels: Record<string, string> = {
  ADMIN: "Administrador",
  VENDEDOR: "Vendedor",
  ESTOQUE: "Estoque",
  FINANCEIRO: "Financeiro",
  COMUNICACAO: "Comunicação",
  MODERADOR: "Moderador",
  CONSUMIDOR: "Consumidor",
};

export default async function FoundationDashboard() {
  const user = await requireSession();
  const pdvUrl = process.env.NEXT_PUBLIC_PDV_URL ?? "http://127.0.0.1:3001";
  const canAccessPdv = user.roles.some((role) => role === "ADMIN" || role === "VENDEDOR");

  return (
    <main className="min-h-full bg-slate-50 p-6 md:p-10">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm md:p-10">
          <span className="inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-black uppercase tracking-widest text-emerald-700">
            Fundação v2.1 greenfield
          </span>
          <h1 className="mt-5 text-3xl font-black tracking-tight text-slate-950 md:text-5xl">
            Olá, {user.name}
          </h1>
          <p className="mt-3 max-w-3xl text-base leading-7 text-slate-600">
            Sua sessão usa exclusivamente Supabase Auth. Os domínios operacionais serão liberados em
            entregas posteriores, depois que seus modelos transacionais v2 estiverem prontos.
          </p>
          <div className="mt-6 flex flex-wrap gap-2" aria-label="Papéis do usuário">
            {user.roles.map((role) => (
              <span key={role} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700">
                {roleLabels[role] ?? role}
              </span>
            ))}
          </div>
        </header>

        <section className="grid gap-4 md:grid-cols-3">
          <article className="rounded-3xl border border-slate-200 bg-white p-6">
            <Database className="size-7 text-emerald-600" aria-hidden="true" />
            <h2 className="mt-5 text-lg font-black text-slate-900">Persistência única</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">Supabase local, migrations versionadas e nenhuma dependência do banco legado.</p>
          </article>
          <article className="rounded-3xl border border-slate-200 bg-white p-6">
            <ShieldCheck className="size-7 text-emerald-600" aria-hidden="true" />
            <h2 className="mt-5 text-lg font-black text-slate-900">Identidade central</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">Papéis e permissões vivem no Supabase, protegidos por RLS e verificados no servidor.</p>
          </article>
          <article className="rounded-3xl border border-slate-200 bg-white p-6">
            <Wrench className="size-7 text-amber-600" aria-hidden="true" />
            <h2 className="mt-5 text-lg font-black text-slate-900">Domínios em implementação</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">Catálogo, estoque, vendas, pagamentos, reservas, rifas e financeiro ainda não estão disponíveis.</p>
          </article>
        </section>

        {canAccessPdv && (
          <section className="flex flex-col gap-4 rounded-3xl bg-slate-950 p-7 text-white md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-xl font-black">Fundação do PDV</h2>
              <p className="mt-1 text-sm text-slate-300">A aplicação separada está disponível para validar autenticação e autorização.</p>
            </div>
            <Link href={pdvUrl} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-emerald-500 px-5 py-3 font-black text-slate-950 transition hover:bg-emerald-400">
              <Store className="size-5" aria-hidden="true" />
              Abrir PDV
            </Link>
          </section>
        )}
      </div>
    </main>
  );
}
