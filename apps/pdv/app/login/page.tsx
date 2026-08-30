"use client";

import { institutionalEmailSchema } from "@germinatura/contracts";
import { Loader2, Mail, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { getSupabaseBrowserClient } from "@/lib/supabase";

async function hashSubject(scope: "OTP_REQUEST" | "OTP_VERIFY", email: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${scope}:${email}:pdv-browser`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

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
      const parsed = institutionalEmailSchema.safeParse(email);
      if (!parsed.success) throw new Error("Use seu email @institutojef.org.br");
      const client = getSupabaseBrowserClient();
      const scope = codeRequested ? "OTP_VERIFY" : "OTP_REQUEST";
      const { data: permitted, error: rateError } = await client.rpc("consume_institutional_auth_rate_limit", {
        p_scope: scope,
        p_subject_hash: await hashSubject(scope, parsed.data),
      });
      if (rateError) throw new Error("Autenticação temporariamente indisponível");
      if (!permitted) throw new Error("Aguarde antes de tentar novamente");
      if (!codeRequested) {
        const { error: otpError } = await client.auth.signInWithOtp({ email: parsed.data, options: { shouldCreateUser: true } });
        if (otpError) throw new Error("Não foi possível enviar o código");
        setEmail(parsed.data);
        setCodeRequested(true);
        showToast("Código enviado ao email institucional", "success");
        return;
      }
      const { error: verifyError } = await client.auth.verifyOtp({ email: parsed.data, token, type: "email" });
      if (verifyError) throw new Error("Código inválido ou expirado");
      const { data: sessionData, error: sessionError } = await client.rpc("get_my_session");
      const roles = sessionData && typeof sessionData === "object" && "roles" in sessionData ? sessionData.roles as unknown[] : [];
      const active = sessionData && typeof sessionData === "object" && "active" in sessionData ? sessionData.active === true : false;
      if (sessionError || !active || (!roles.includes("ADMIN") && !roles.includes("VENDEDOR"))) {
        await client.auth.signOut();
        throw new Error("Seu perfil não possui acesso ativo ao PDV");
      }
      window.location.assign(roles.includes("ADMIN") ? process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://127.0.0.1:3000" : "/");
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
      <section className="w-full max-w-md overflow-hidden rounded-3xl border border-slate-100 bg-white shadow-xl">
        <header className="p-8 text-center">
          <img src="https://i.imgur.com/EnMI9CP.png" alt="Germinatura" className="mx-auto mb-4 size-16 rounded-2xl" />
          <h1 className="text-3xl font-black text-slate-900">PDV Germinatura</h1>
          <p className="mt-2 font-medium text-slate-500">Acesso exclusivo para vendedores ativos</p>
        </header>
        <form onSubmit={submit} className="space-y-6 px-8 pb-8">
          {error && <p role="alert" className="rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{error}</p>}
          <label className="block space-y-2 text-sm font-bold text-slate-700">Email institucional<span className="relative block"><Mail aria-hidden="true" className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-slate-400" /><input required disabled={codeRequested || loading} type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="nome@institutojef.org.br" className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-4 pl-12 pr-4 outline-none focus:ring-2 focus:ring-primary disabled:opacity-70" /></span></label>
          {codeRequested && <label className="block space-y-2 text-sm font-bold text-slate-700">Código de 6 dígitos<span className="relative block"><ShieldCheck aria-hidden="true" className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-slate-400" /><input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={token} onChange={(event) => setToken(event.target.value.replace(/\D/g, ""))} className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-4 pl-12 pr-4 text-center text-xl font-bold tracking-[0.35em] outline-none focus:ring-2 focus:ring-primary" /></span></label>}
          <button disabled={loading} className="flex w-full items-center justify-center gap-3 rounded-2xl bg-primary py-4 text-lg font-bold text-white disabled:opacity-50">{loading ? <Loader2 aria-label="Aguarde" className="size-6 animate-spin" /> : codeRequested ? "Confirmar código" : "Receber código"}</button>
          {codeRequested && <button type="button" onClick={() => { setCodeRequested(false); setToken(""); }} className="w-full text-sm font-semibold text-slate-600 hover:underline">Usar outro email</button>}
        </form>
      </section>
    </main>
  );
}
