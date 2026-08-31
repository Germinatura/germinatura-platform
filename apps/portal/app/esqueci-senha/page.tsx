"use client";

import { passwordRecoveryRequestSchema, passwordRecoveryVerifySchema } from "@germinatura/contracts";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

export default function EsqueciSenhaPage() {
  const [identifier, setIdentifier] = useState("");
  const [token, setToken] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const schema = codeSent ? passwordRecoveryVerifySchema : passwordRecoveryRequestSchema;
      const parsed = schema.safeParse(codeSent ? { identifier, token } : { identifier });
      if (!parsed.success) throw new Error(codeSent ? "Informe o código de 6 dígitos" : "Informe usuário ou e-mail válido");
      const response = await fetch(codeSent ? "/api/v1/auth/password-recovery/verify" : "/api/v1/auth/password-recovery/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "Não foi possível recuperar a senha");
      if (!codeSent) {
        setIdentifier((parsed.data as { identifier: string }).identifier);
        setCodeSent(true);
      } else {
        window.location.assign("/recuperar-senha");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Recuperação temporariamente indisponível");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background-light p-4">
      <section className="w-full max-w-md rounded-3xl bg-white p-8 shadow-xl">
        <h1 className="text-3xl font-black text-slate-900">Recuperar senha</h1>
        <p className="mt-2 text-slate-500">Você pode solicitar dois códigos. Na terceira tentativa, peça o desbloqueio a um administrador.</p>
        <form onSubmit={submit} className="mt-6 space-y-5">
          {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-700">{error}</p>}
          <label className="grid gap-2 font-bold text-slate-700">Usuário ou e-mail<input required disabled={codeSent} autoComplete="username" value={identifier} onChange={(event) => setIdentifier(event.target.value)} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 disabled:opacity-70" /></label>
          {codeSent && <label className="grid gap-2 font-bold text-slate-700">Código de 6 dígitos<input required inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={token} onChange={(event) => setToken(event.target.value.replace(/\D/g, ""))} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-center text-xl tracking-[.3em]" /></label>}
          <button disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary p-4 font-bold text-white disabled:opacity-50">{loading ? <Loader2 className="size-5 animate-spin" /> : codeSent ? "Confirmar código" : "Enviar código"}</button>
        </form>
        <Link href="/login" className="mt-5 block text-center text-sm font-semibold text-slate-600 hover:underline">Voltar ao login</Link>
      </section>
    </main>
  );
}
