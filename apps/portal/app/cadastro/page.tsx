"use client";

import { signupRequestSchema, signupVerifySchema } from "@germinatura/contracts";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setExistingAccount(false);
    try {
      const schema = codeSent ? signupVerifySchema : signupRequestSchema;
      const parsed = schema.safeParse(codeSent ? { email, token } : { email });
      if (!parsed.success) throw new Error(codeSent ? "Informe o código de 6 dígitos" : "Use seu e-mail @institutojef.org.br");
      const response = await fetch(codeSent ? "/api/v1/auth/signup/verify" : "/api/v1/auth/signup/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const body = await response.json();
      if (!response.ok) {
        if (body.code === "ACCOUNT_ALREADY_EXISTS") setExistingAccount(true);
        throw new Error(body.message ?? "Não foi possível continuar o cadastro");
      }
      if (!codeSent) {
        setEmail((parsed.data as { email: string }).email);
        sessionStorage.removeItem("germinatura.signup.email");
        setCodeSent(true);
      } else {
        window.location.assign("/cadastro/perfil");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Cadastro temporariamente indisponível");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background-light p-4">
      <section className="w-full max-w-md rounded-3xl bg-white p-8 shadow-xl">
        <h1 className="text-3xl font-black text-slate-900">Criar conta</h1>
        <p className="mt-2 text-slate-500">Primeiro, confirme seu e-mail institucional.</p>
        <form onSubmit={submit} className="mt-6 space-y-5">
          {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-700">{error}</p>}
          {existingAccount && <Link href="/login" className="block rounded-xl border border-primary px-4 py-3 text-center text-sm font-bold text-primary hover:bg-primary/5">Ir para o login</Link>}
          <label className="block space-y-2 font-bold text-slate-700">E-mail institucional<input required disabled={codeSent} type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className="w-full rounded-2xl border border-slate-200 bg-slate-50 p-4 disabled:opacity-70" /></label>
          {codeSent && <label className="block space-y-2 font-bold text-slate-700">Código de 6 dígitos<input required inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={token} onChange={(event) => setToken(event.target.value.replace(/\D/g, ""))} className="w-full rounded-2xl border border-slate-200 bg-slate-50 p-4 text-center text-xl tracking-[.3em]" /></label>}
          <button disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary p-4 font-bold text-white disabled:opacity-50">{loading ? <Loader2 className="size-5 animate-spin" /> : codeSent ? "Confirmar código" : "Enviar código"}</button>
        </form>
        <Link href="/login" className="mt-5 block text-center text-sm font-semibold text-slate-600 hover:underline">Já tenho uma conta</Link>
      </section>
    </main>
  );
}
