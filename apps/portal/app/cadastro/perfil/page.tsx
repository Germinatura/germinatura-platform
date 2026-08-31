"use client";

import { signupCompleteSchema } from "@germinatura/contracts";
import { Loader2 } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { getPortalSupabaseBrowserClient } from "@/lib/supabase/browser";

export default function CompletarPerfilPage() {
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const ready = useSyncExternalStore(() => () => undefined, () => true, () => false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      if (password !== confirmation) throw new Error("As senhas não coincidem");
      const client = getPortalSupabaseBrowserClient();
      let avatarPath: string | null = null;
      if (photo) {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(photo.type) || photo.size > 5 * 1024 * 1024) {
          throw new Error("A foto deve ser JPG, PNG ou WebP de até 5 MB");
        }
        const { data: authData } = await client.auth.getUser();
        if (!authData.user) throw new Error("Confirme novamente seu e-mail");
        const extension = photo.type === "image/png" ? "png" : photo.type === "image/webp" ? "webp" : "jpg";
        avatarPath = `${authData.user.id}/${crypto.randomUUID()}.${extension}`;
        const { error: uploadError } = await client.storage.from("profile-photos").upload(avatarPath, photo, { contentType: photo.type });
        if (uploadError) throw new Error("Não foi possível enviar a foto");
      }
      const parsed = signupCompleteSchema.safeParse({ displayName, username, password, avatarPath });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Revise os dados do perfil");
      const response = await fetch("/api/v1/auth/signup/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "Não foi possível concluir o cadastro");
      window.location.assign("/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Cadastro temporariamente indisponível");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background-light p-4">
      <section className="w-full max-w-lg rounded-3xl bg-white p-8 shadow-xl">
        <h1 className="text-3xl font-black text-slate-900">Complete seu perfil</h1>
        <p className="mt-2 text-slate-500">Seu e-mail já foi confirmado e não pode ser alterado aqui.</p>
        <form onSubmit={submit} data-hydrated={ready} className="mt-6 grid gap-5">
          {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-700">{error}</p>}
          <label className="grid gap-2 font-bold text-slate-700">Nome<input required autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="rounded-2xl border border-slate-200 bg-slate-50 p-4" /></label>
          <label className="grid gap-2 font-bold text-slate-700">Username<input required autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value.toLowerCase())} placeholder="seu.usuario" className="rounded-2xl border border-slate-200 bg-slate-50 p-4" /><span className="text-xs font-medium text-slate-500">3–32 caracteres: letras minúsculas, números, ponto e underscore.</span></label>
          <label className="grid gap-2 font-bold text-slate-700">Senha<input required type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className="rounded-2xl border border-slate-200 bg-slate-50 p-4" /></label>
          <label className="grid gap-2 font-bold text-slate-700">Confirmar senha<input required type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="rounded-2xl border border-slate-200 bg-slate-50 p-4" /></label>
          <label className="grid gap-2 font-bold text-slate-700">Foto (opcional)<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setPhoto(event.target.files?.[0] ?? null)} className="rounded-2xl border border-slate-200 bg-slate-50 p-4" /></label>
          <button disabled={loading || !ready} className="flex items-center justify-center gap-2 rounded-2xl bg-primary p-4 font-bold text-white disabled:opacity-50">{loading ? <Loader2 className="size-5 animate-spin" /> : "Concluir cadastro"}</button>
        </form>
      </section>
    </main>
  );
}
