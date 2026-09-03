"use client";

import { credentialLoginRequestSchema } from "@germinatura/contracts";
import { BrandMark, Button, Card, Field, Input } from "@germinatura/ui";
import { LockKeyhole, ShieldCheck, UserRound } from "lucide-react";
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

  const portalUrl = process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://127.0.0.1:3000";
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--g-surface-canvas)] p-4 font-sans">
      <Card className="w-full max-w-md overflow-hidden shadow-[var(--g-shadow-raised)]">
        <div className="h-1 bg-[var(--g-brand-primary)]" />
        <header className="px-6 pb-5 pt-8 text-center sm:px-8">
          <BrandMark title="Germinatura" tone="inverse" className="mx-auto mb-5 size-14 text-white" />
          <h1 className="text-2xl font-bold tracking-tight">Acessar o PDV</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--g-text-secondary)]">Entre com a conta operacional criada por um administrador.</p>
        </header>
        <form onSubmit={submit} className="space-y-5 px-6 pb-8 sm:px-8">
          {error && <p role="alert" className="rounded-[var(--g-radius-control)] border border-[var(--g-status-danger)]/50 bg-[var(--g-surface-subtle)] px-4 py-3 text-sm font-semibold text-[var(--g-status-danger)]">{error}</p>}
          <Field id="pdv-identifier" label="Usuário ou e-mail"><div className="relative"><UserRound aria-hidden="true" className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-[var(--g-text-muted)]" /><Input id="pdv-identifier" required autoComplete="username" value={identifier} onChange={(event) => setIdentifier(event.target.value)} className="g-input--with-icon" /></div></Field>
          <Field id="pdv-password" label="Senha"><div className="relative"><LockKeyhole aria-hidden="true" className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-[var(--g-text-muted)]" /><Input id="pdv-password" required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="g-input--with-icon" /></div></Field>
          <Button type="submit" variant="brand" size="lg" className="w-full" loading={loading}>Entrar</Button>
          <a href={`${portalUrl}/esqueci-senha`} className="block min-h-11 py-3 text-center text-sm font-semibold text-[var(--g-text-secondary)] hover:text-[var(--g-text-primary)] hover:underline">Esqueci minha senha</a>
        </form>
        <div className="flex items-center justify-center gap-2 border-t border-[var(--g-border-subtle)] bg-[var(--g-surface-subtle)] px-6 py-4 text-xs text-[var(--g-text-muted)]"><ShieldCheck className="size-4" /> Acesso restrito a vendedores ativos</div>
      </Card>
    </main>
  );
}
