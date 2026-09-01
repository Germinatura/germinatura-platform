"use client";

import { signupRequestSchema, signupVerifySchema } from "@germinatura/contracts";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

function preservedSignupEmail(): string {
  if (typeof window === "undefined") return "";
  const parsed = signupRequestSchema.safeParse({
    email: sessionStorage.getItem("germinatura.signup.email"),
  });
  return parsed.success ? parsed.data.email : "";
}

export default function CadastroPage() {
  const [email, setEmail] = useState(preservedSignupEmail);
  const [token, setToken] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [existingAccount, setExistingAccount] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [resendUsed, setResendUsed] = useState(false);
  const [adminResetRequired, setAdminResetRequired] = useState(false);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setInterval(() => setResendSeconds((current) => Math.max(0, current - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [resendSeconds]);

  async function requestCode() {
    const parsed = signupRequestSchema.safeParse({ email });
    if (!parsed.success) throw new Error("Use seu e-mail @institutojef.org.br");
    const response = await fetch("/api/v1/auth/signup/request", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed.data),
    });
    const body = await response.json();
    if (!response.ok) {
      if (body.code === "ACCOUNT_ALREADY_EXISTS") setExistingAccount(true);
      if (body.code === "ADMIN_RESET_REQUIRED") setAdminResetRequired(true);
      if (body.code === "CODE_RESEND_TOO_SOON") {
        setResendSeconds(Number(response.headers.get("Retry-After")) || 90);
      }
      throw new Error(body.message ?? "Não foi possível solicitar o código");
    }
    setEmail(parsed.data.email);
    sessionStorage.removeItem("germinatura.signup.email");
    setCodeSent(true);
    setResendSeconds(Number(body.resend_after_seconds) || 0);
    setResendUsed(body.resend_used === true);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setExistingAccount(false);
    try {
      if (!codeSent) {
        await requestCode();
        return;
      }
      const parsed = signupVerifySchema.safeParse({ email, token });
      if (!parsed.success) throw new Error("Informe o código de 6 a 10 dígitos");
      const response = await fetch("/api/v1/auth/signup/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "Não foi possível continuar o cadastro");
      window.location.assign("/cadastro/perfil");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Cadastro temporariamente indisponível");
    } finally {
      setLoading(false);
    }
  }

  async function resendCode() {
    setLoading(true); setError("");
    try { await requestCode(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Não foi possível reenviar o código"); }
    finally { setLoading(false); }
  }

  function chooseAnotherEmail() {
    setEmail(""); setToken(""); setCodeSent(false); setError(""); setExistingAccount(false);
    setResendSeconds(0); setResendUsed(false); setAdminResetRequired(false);
    sessionStorage.removeItem("germinatura.signup.email");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background-light p-4">
      <section className="w-full max-w-md rounded-3xl bg-white p-8 shadow-xl">
        <h1 className="text-3xl font-black text-slate-900">Criar conta</h1>
        <p className="mt-2 text-slate-500">Primeiro, confirme seu e-mail institucional.</p>
        <form onSubmit={submit} className="mt-6 space-y-5">
          {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-700">{error}</p>}
          {adminResetRequired && <p className="rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-800">Contate um administrador para liberar novos códigos.</p>}
          {existingAccount && <Link href="/login" className="block rounded-xl border border-primary px-4 py-3 text-center text-sm font-bold text-primary hover:bg-primary/5">Ir para o login</Link>}
          <label className="block space-y-2 font-bold text-slate-700">E-mail institucional<input required disabled={codeSent} type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className="w-full rounded-2xl border border-slate-200 bg-slate-50 p-4 disabled:opacity-70" /></label>
          {codeSent && <label className="block space-y-2 font-bold text-slate-700">Código de 6 a 10 dígitos<input required inputMode="numeric" autoComplete="one-time-code" minLength={6} maxLength={10} value={token} onChange={(event) => setToken(event.target.value.replace(/\D/g, ""))} className="w-full rounded-2xl border border-slate-200 bg-slate-50 p-4 text-center text-xl tracking-[.3em]" /></label>}
          <button disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary p-4 font-bold text-white disabled:opacity-50">{loading ? <Loader2 className="size-5 animate-spin" /> : codeSent ? "Confirmar código" : "Enviar código"}</button>
          {codeSent && <div className="grid gap-3 sm:grid-cols-2">
            <button type="button" disabled={loading || resendSeconds > 0 || adminResetRequired} onClick={resendCode} className="rounded-2xl border border-primary px-4 py-3 text-sm font-bold text-primary disabled:cursor-not-allowed disabled:opacity-50">
              {resendSeconds > 0 ? `Reenviar em ${resendSeconds}s` : resendUsed ? "Reenviar novamente" : "Reenviar código"}
            </button>
            <button type="button" disabled={loading} onClick={chooseAnotherEmail} className="rounded-2xl border border-slate-300 px-4 py-3 text-sm font-bold text-slate-700 disabled:opacity-50">Usar outro e-mail</button>
          </div>}
        </form>
        <Link href="/login" className="mt-5 block text-center text-sm font-semibold text-slate-600 hover:underline">Já tenho uma conta</Link>
      </section>
    </main>
  );
}
