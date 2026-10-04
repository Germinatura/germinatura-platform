"use client";

import { passwordRecoveryCompleteSchema } from "@germinatura/contracts";
import { Loader2 } from "lucide-react";
import { useState } from "react";

export default function RecuperarSenhaPage() {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      if (password !== confirmation) throw new Error("As senhas não coincidem");
      const parsed = passwordRecoveryCompleteSchema.safeParse({ password });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "A senha não atende aos requisitos");
      const response = await fetch("/api/v1/auth/password-recovery/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "Não foi possível alterar a senha");
      window.location.assign("/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Recuperação temporariamente indisponível");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background-light p-4">
      <section className="w-full max-w-md rounded-3xl bg-white p-8 shadow-xl">
        <h1 className="text-3xl font-black text-slate-900">Defina a nova senha</h1>
        <form onSubmit={submit} className="mt-6 space-y-5">
          {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-700">{error}</p>}
          <label className="grid gap-2 font-bold text-slate-700">Nova senha<input required type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className="rounded-2xl border border-slate-200 bg-slate-50 p-4" /></label>
          <label className="grid gap-2 font-bold text-slate-700">Confirmar nova senha<input required type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="rounded-2xl border border-slate-200 bg-slate-50 p-4" /></label>
          <button disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary p-4 font-bold text-white disabled:opacity-50">{loading ? <Loader2 className="size-5 animate-spin" /> : "Salvar nova senha"}</button>
        </form>
      </section>
    </main>
  );
}
