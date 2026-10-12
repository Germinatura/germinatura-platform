"use client";

import { signupCompleteSchema } from "@germinatura/contracts";
import { Loader2 } from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";
import { AvatarPicker } from "@/components/account/AvatarPicker";
import { prepareProfilePhoto } from "@/lib/profile-photo";
import { getPortalSupabaseBrowserClient } from "@/lib/supabase/browser";

const USERNAME_RULE = "De 3 a 32 caracteres: comece com uma letra; depois use letras minúsculas, números, ponto ou underscore.";
// min-w-0 + w-full keep every control inside the card down to 320 px; the card's padding shrinks on narrow screens.
const inputClass = "w-full min-w-0 rounded-2xl border border-slate-200 bg-slate-50 p-3.5 font-normal sm:p-4";
const fieldClass = "grid min-w-0 gap-2 font-bold text-slate-700";
const hintClass = "text-xs font-medium text-slate-500 [overflow-wrap:anywhere]";

export default function CompletarPerfilPage() {
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const ready = useSyncExternalStore(() => () => undefined, () => true, () => false);
  const [error, setError] = useState("");
  const [usernameError, setUsernameError] = useState("");
  // A retry after a refused username reuses the photo already sent instead of uploading another copy.
  const uploaded = useRef<{ file: File; path: string } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setUsernameError("");
    try {
      if (password !== confirmation) throw new Error("As senhas não coincidem");
      const draft = signupCompleteSchema.safeParse({ displayName, username, password, avatarPath: null });
      if (!draft.success) {
        if (draft.error.issues.some((issue) => issue.path[0] === "username")) {
          setUsernameError(USERNAME_RULE);
          document.getElementById("signup-username")?.focus();
          return;
        }
        throw new Error(draft.error.issues[0]?.path[0] === "password"
          ? "A senha precisa de 8 caracteres ou mais, com letra minúscula, maiúscula e número"
          : "Revise os dados do perfil");
      }
      let avatarPath: string | null = null;
      if (photo) {
        if (uploaded.current?.file !== photo) {
          const client = getPortalSupabaseBrowserClient();
          const { data: authData } = await client.auth.getUser();
          if (!authData.user) throw new Error("Confirme novamente seu e-mail");
          const blob = await prepareProfilePhoto(photo);
          const path = `${authData.user.id}/${crypto.randomUUID()}.webp`;
          const { error: uploadError } = await client.storage.from("profile-photos").upload(path, blob, { contentType: "image/webp", upsert: false });
          if (uploadError) throw new Error("Não foi possível enviar a foto");
          uploaded.current = { file: photo, path };
        }
        avatarPath = uploaded.current.path;
      }
      const response = await fetch("/api/v1/auth/signup/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft.data, avatarPath }),
      });
      const body = await response.json();
      if (!response.ok) {
        if (body.code === "USERNAME_ALREADY_USED") {
          setUsernameError("Este nome de usuário já está em uso. Escolha outro.");
          document.getElementById("signup-username")?.focus();
          return;
        }
        throw new Error(body.message ?? "Não foi possível concluir o cadastro");
      }
      window.location.assign("/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Cadastro temporariamente indisponível");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-start justify-center bg-background-light px-4 py-6 sm:items-center sm:p-6">
      <section className="w-full min-w-0 max-w-lg rounded-3xl bg-white p-5 shadow-xl sm:p-8">
        <h1 className="text-2xl font-black text-slate-900 sm:text-3xl">Complete seu perfil</h1>
        <p className="mt-2 text-slate-500">Seu e-mail já foi confirmado e não pode ser alterado.</p>
        <form onSubmit={submit} data-hydrated={ready} className="mt-6 grid min-w-0 gap-5">
          {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-700">{error}</p>}
          <div className={fieldClass}><label htmlFor="signup-name">Nome</label>
            <input id="signup-name" required autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} className={inputClass} /></div>
          <div className={fieldClass}><label htmlFor="signup-username">Nome de usuário</label>
            <input id="signup-username" required autoComplete="username" autoCapitalize="none" spellCheck={false} value={username}
              aria-invalid={usernameError ? true : undefined} aria-describedby="signup-username-hint"
              onChange={(event) => { setUsernameError(""); setUsername(event.target.value.toLowerCase()); }} placeholder="seu.usuario" className={inputClass} />
            {usernameError
              ? <span id="signup-username-hint" role="alert" className="text-xs font-semibold text-rose-700 [overflow-wrap:anywhere]">{usernameError}</span>
              : <span id="signup-username-hint" className={hintClass}>{USERNAME_RULE} Você poderá alterá-lo depois no seu perfil.</span>}
          </div>
          <div className={fieldClass}><label htmlFor="signup-password">Senha</label>
            <input id="signup-password" required type="password" autoComplete="new-password" aria-describedby="signup-password-hint" value={password} onChange={(event) => setPassword(event.target.value)} className={inputClass} />
            <span id="signup-password-hint" className={hintClass}>8 caracteres ou mais, com letra minúscula, maiúscula e número.</span></div>
          <div className={fieldClass}><label htmlFor="signup-confirmation">Confirmar senha</label>
            <input id="signup-confirmation" required type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className={inputClass} /></div>
          <AvatarPicker id="signup-photo" label="Foto (opcional)" savedUrl={null} fallback={displayName[0] ?? ""} file={photo} disabled={loading}
            onChange={(file) => { setPhoto(file); uploaded.current = null; }} />
          <button disabled={loading || !ready} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary p-4 font-bold text-white disabled:opacity-50">{loading ? <Loader2 className="size-5 animate-spin" /> : "Concluir cadastro"}</button>
        </form>
      </section>
    </main>
  );
}
