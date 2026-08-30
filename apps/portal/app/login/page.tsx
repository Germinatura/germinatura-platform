"use client";

import { institutionalEmailSchema } from "@germinatura/contracts";
import { Loader2, Mail, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/components/ui/Toast";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [codeRequested, setCodeRequested] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { showToast } = useToast();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const parsedEmail = institutionalEmailSchema.safeParse(email);
      if (!parsedEmail.success) throw new Error("Use seu email @institutojef.org.br");
      const response = await fetch(codeRequested ? "/api/v1/auth/otp/verify" : "/api/v1/auth/otp/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(codeRequested ? { email: parsedEmail.data, token } : { email: parsedEmail.data }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "Não foi possível autenticar");
      if (!codeRequested) {
        setEmail(parsedEmail.data);
        setCodeRequested(true);
        showToast("Código enviado ao email institucional", "success");
        return;
      }
      const roles: string[] = body.user?.roles ?? [];
      const pdvUrl = process.env.NEXT_PUBLIC_PDV_URL ?? "http://127.0.0.1:3001";
      window.location.assign(roles.includes("VENDEDOR") && !roles.includes("ADMIN") ? pdvUrl : "/");
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
          <form onSubmit={submit} className="space-y-6 p-8">
            {error && <p role="alert" className="rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{error}</p>}
            <div className="space-y-2">
              <label htmlFor="institutional-email" className="ml-1 text-sm font-bold text-slate-700">Email institucional</label>
              <div className="relative">
                <Mail aria-hidden="true" className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-slate-400" />
                <input id="institutional-email" required disabled={codeRequested || loading} type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="nome@institutojef.org.br" className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-4 pl-12 pr-4 font-medium outline-none focus:border-primary focus:ring-2 focus:ring-primary disabled:opacity-70" />
              </div>
            </div>
            {codeRequested && (
              <div className="space-y-2">
                <label htmlFor="otp-code" className="ml-1 text-sm font-bold text-slate-700">Código de 6 dígitos</label>
                <div className="relative">
                  <ShieldCheck aria-hidden="true" className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-slate-400" />
                  <input id="otp-code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={token} onChange={(event) => setToken(event.target.value.replace(/\D/g, ""))} className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-4 pl-12 pr-4 text-center text-xl font-bold tracking-[0.35em] outline-none focus:border-primary focus:ring-2 focus:ring-primary" />
                </div>
              </div>
            )}
            <button disabled={loading} type="submit" className="flex w-full items-center justify-center gap-3 rounded-2xl bg-primary py-4 text-lg font-bold text-white shadow-lg shadow-primary/30 transition hover:bg-primary/90 disabled:opacity-50">
              {loading ? <Loader2 aria-label="Aguarde" className="size-6 animate-spin" /> : codeRequested ? "Confirmar código" : "Receber código"}
            </button>
            {codeRequested && <button type="button" onClick={() => { setCodeRequested(false); setToken(""); setError(""); }} className="w-full text-sm font-semibold text-slate-600 hover:underline">Usar outro email</button>}
          </form>
          <p className="border-t border-slate-100 bg-slate-50 p-6 text-center text-sm font-medium text-slate-500">Nenhuma senha é solicitada ou armazenada pela Germinatura.</p>
        </section>
      </div>
    </main>
  );
}
