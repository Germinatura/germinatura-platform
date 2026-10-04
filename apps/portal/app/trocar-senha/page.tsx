"use client";

import { useState } from "react";
import { Eye, EyeOff, Lock, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button, Card } from "@germinatura/ui";
import { useToast } from "@/components/ui/Toast";

export default function TrocarSenhaPage() {
  const [novaSenha, setNovaSenha] = useState("");
  const [confirmarSenha, setConfirmarSenha] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  const { showToast } = useToast();

  async function handleReset(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");

    if (novaSenha !== confirmarSenha) {
      setError("As senhas não coincidem.");
      setLoading(false);
      return;
    }
    if (novaSenha.length < 8) {
      setError("A nova senha deve ter pelo menos 8 caracteres.");
      setLoading(false);
      return;
    }

    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ novaSenha }),
      });
      const body = await response.json().catch(() => null) as { message?: string } | null;
      if (!response.ok) throw new Error(body?.message ?? "Não foi possível alterar a senha.");
      showToast("Senha alterada com sucesso.", "success");
      router.push("/");
    } catch (resetError) {
      const message = resetError instanceof Error ? resetError.message : "Não foi possível conectar ao servidor.";
      setError(message);
      showToast(message, "error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <div className="mx-auto max-w-3xl">
        <header>
          <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Segurança da conta</p>
          <h2 className="mt-1 text-3xl font-bold tracking-tight text-[var(--g-text-primary)]">Alterar senha</h2>
          <p className="mt-2 max-w-2xl text-base leading-6 text-[var(--g-text-secondary)]">Escolha uma senha nova com pelo menos 8 caracteres.</p>
        </header>

        <Card className="mt-8 overflow-hidden">
          <div className="border-b border-[var(--g-border-subtle)] p-6 sm:p-8">
            <div className="flex items-start gap-4">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-[var(--g-radius-control)] bg-[var(--g-brand-primary-soft)] text-[var(--g-brand-primary)]"><ShieldCheck className="size-5" /></span>
              <div><h3 className="text-lg font-semibold text-[var(--g-text-primary)]">Proteja seu acesso</h3><p className="mt-1 text-sm leading-6 text-[var(--g-text-secondary)]">Sua senha é protegida e não pode ser consultada por administradores.</p></div>
            </div>
          </div>

          <form onSubmit={handleReset} className="space-y-6 p-6 sm:p-8">
            {error && <p role="alert" className="rounded-[var(--g-radius-control)] border border-[var(--g-status-danger)] bg-[var(--g-status-danger-soft)] px-4 py-3 text-sm font-medium text-[var(--g-status-danger-foreground)]">{error}</p>}

            <div className="space-y-2">
              <label htmlFor="new-password" className="block text-sm font-semibold text-[var(--g-text-primary)]">Nova senha</label>
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-[var(--g-text-muted)]" aria-hidden="true" />
                <input id="new-password" required minLength={8} autoComplete="new-password" type={showPassword ? "text" : "password"} value={novaSenha} onChange={(event) => setNovaSenha(event.target.value)} className="g-input pl-12 pr-12" aria-describedby="password-help" />
                <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-1 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-[var(--g-radius-control)] text-[var(--g-text-muted)] hover:bg-[var(--g-surface-hover)]" aria-label={showPassword ? "Ocultar nova senha" : "Mostrar nova senha"}>{showPassword ? <EyeOff className="size-5" /> : <Eye className="size-5" />}</button>
              </div>
              <p id="password-help" className="text-xs text-[var(--g-text-muted)]">Use pelo menos 8 caracteres e evite senhas utilizadas em outros serviços.</p>
            </div>

            <div className="space-y-2">
              <label htmlFor="confirm-password" className="block text-sm font-semibold text-[var(--g-text-primary)]">Confirmar nova senha</label>
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-[var(--g-text-muted)]" aria-hidden="true" />
                <input id="confirm-password" required minLength={8} autoComplete="new-password" type={showConfirmPassword ? "text" : "password"} value={confirmarSenha} onChange={(event) => setConfirmarSenha(event.target.value)} className="g-input pl-12 pr-12" />
                <button type="button" onClick={() => setShowConfirmPassword(!showConfirmPassword)} className="absolute right-1 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-[var(--g-radius-control)] text-[var(--g-text-muted)] hover:bg-[var(--g-surface-hover)]" aria-label={showConfirmPassword ? "Ocultar confirmação de senha" : "Mostrar confirmação de senha"}>{showConfirmPassword ? <EyeOff className="size-5" /> : <Eye className="size-5" />}</button>
              </div>
            </div>

            <div className="flex flex-col-reverse gap-3 border-t border-[var(--g-border-subtle)] pt-6 sm:flex-row sm:justify-end">
              <Button type="button" variant="secondary" onClick={() => router.push("/")}>Cancelar</Button>
              <Button type="submit" loading={loading} disabled={!novaSenha || !confirmarSenha}>Salvar nova senha</Button>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}
