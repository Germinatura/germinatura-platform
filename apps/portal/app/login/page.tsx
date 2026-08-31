"use client";

import { credentialLoginRequestSchema } from "@germinatura/contracts";
import { Loader2, LockKeyhole, UserRound } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useToast } from "@/components/ui/Toast";

export default function LoginPage() {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { showToast } = useToast();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const parsed = credentialLoginRequestSchema.safeParse({ identifier, password });
      if (!parsed.success) throw new Error("Informe seu usuário/e-mail e senha");
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "Usuário/e-mail ou senha inválidos");
      window.location.assign("/");
    } catch (loginError) {
      const message = loginError instanceof Error ? loginError.message : "Erro ao conectar com o servidor";
      setError(message);
      showToast(message, "error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background-light p-4 font-sans">
      <div className="w-full max-w-md">
        <header className="mb-8 text-center">
          <img src="https://i.imgur.com/EnMI9CP.png" alt="Germinatura" className="mx-auto mb-4 size-16 rounded-2xl shadow-lg" />
          <h1 className="text-3xl font-black tracking-tight text-slate-900">Germinatura</h1>
          <p className="mt-2 font-medium text-slate-500">Acesso da comunidade Germinare</p>
        </header>
        <section className="overflow-hidden rounded-3xl border border-slate-100 bg-white shadow-xl shadow-slate-200/50">
          <form onSubmit={submit} className="space-y-5 p-8">
            {error && <p role="alert" className="rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{error}</p>}
            <label className="block space-y-2 text-sm font-bold text-slate-700">
              Usuário ou e-mail
              <span className="relative block">
                <UserRound aria-hidden="true" className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-slate-400" />
                <input required autoComplete="username" value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder="seu.usuario ou email@institutojef.org.br" className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-4 pl-12 pr-4 outline-none focus:ring-2 focus:ring-primary" />
              </span>
            </label>
            <label className="block space-y-2 text-sm font-bold text-slate-700">
              Senha
              <span className="relative block">
                <LockKeyhole aria-hidden="true" className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-slate-400" />
                <input required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-4 pl-12 pr-4 outline-none focus:ring-2 focus:ring-primary" />
              </span>
            </label>
            <div className="flex items-center justify-between gap-4 text-sm font-semibold">
              <Link href="/cadastro" className="text-primary hover:underline">Criar conta</Link>
              <Link href="/esqueci-senha" className="text-slate-600 hover:underline">Esqueci minha senha</Link>
            </div>
            <button disabled={loading} className="flex w-full items-center justify-center gap-3 rounded-2xl bg-primary py-4 text-lg font-bold text-white disabled:opacity-50">
              {loading ? <Loader2 aria-label="Aguarde" className="size-6 animate-spin" /> : "Entrar"}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
