"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Button, Card, Field, Input } from "@germinatura/ui";
import { privateProfileSchema, sweetPreferences, updateProfileSchema, type PrivateProfile } from "@germinatura/contracts";
import { AvatarPicker } from "@/components/account/AvatarPicker";
import { prepareProfilePhoto } from "@/lib/profile-photo";
import { getPortalSupabaseBrowserClient } from "@/lib/supabase/browser";

const USERNAME_RULE = "De 3 a 32 caracteres: comece com uma letra; depois use letras minúsculas, números, ponto ou underscore.";

export function ProfileEditor({ initial }: { initial: PrivateProfile }) {
  const [profile, setProfile] = useState(initial);
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [username, setUsername] = useState(initial.username);
  const [usernameError, setUsernameError] = useState("");
  const [bio, setBio] = useState(initial.bio);
  const [className, setClassName] = useState(initial.className);
  const [preferences, setPreferences] = useState(initial.sweetPreferences);
  const [photo, setPhoto] = useState<File | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const key = useRef<string | null>(null);
  const uploaded = useRef<{ file: File; path: string } | null>(null);
  const focusUsername = () => document.getElementById("profile-username")?.focus();
  const changed = () => { key.current = null; setNotice(""); setError(""); };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true; setSaving(true); setError(""); setNotice(""); setUsernameError("");
    try {
      let avatarPath = removePhoto ? null : profile.avatarPath;
      if (photo && !removePhoto) {
        if (uploaded.current?.file !== photo) {
          const blob = await prepareProfilePhoto(photo);
          const path = `${profile.id}/${crypto.randomUUID()}.webp`;
          const { error: uploadError } = await getPortalSupabaseBrowserClient().storage.from("profile-photos").upload(path, blob, { contentType: "image/webp", upsert: false });
          if (uploadError) throw new Error("Não foi possível enviar a foto. Tente novamente.");
          uploaded.current = { file: photo, path };
        }
        avatarPath = uploaded.current.path;
      }
      const parsed = updateProfileSchema.safeParse({ expectedRevision: profile.revision, displayName, username, avatarPath, bio, className, sweetPreferences: preferences });
      if (!parsed.success) {
        if (parsed.error.issues.some((issue) => issue.path[0] === "username")) { setUsernameError(USERNAME_RULE); focusUsername(); return; }
        throw new Error("Confira os dados do perfil.");
      }
      key.current ??= `profile:${crypto.randomUUID()}`;
      const response = await fetch("/api/v1/profile", { method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": key.current }, body: JSON.stringify(parsed.data) });
      const body = await response.json() as { data?: unknown; code?: string; message?: string };
      if (!response.ok) {
        if (body.code === "USERNAME_ALREADY_USED" || body.code === "INVALID_USERNAME") {
          key.current = null; setUsernameError(body.message ?? USERNAME_RULE); focusUsername(); return;
        }
        throw new Error(body.message ?? "Não foi possível salvar o perfil.");
      }
      const saved = privateProfileSchema.parse(body.data);
      setProfile(saved); setDisplayName(saved.displayName); setUsername(saved.username); setBio(saved.bio); setClassName(saved.className); setPreferences(saved.sweetPreferences);
      setPhoto(null); setRemovePhoto(false); uploaded.current = null; key.current = null;
      window.dispatchEvent(new Event("germinatura:profile-updated"));
      setNotice("Perfil atualizado.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar. Tente novamente."); }
    finally { submitting.current = false; setSaving(false); }
  }

  return <div className="px-4 py-8 sm:px-6 lg:px-8">
    <div className="mx-auto max-w-3xl space-y-6">
      <header><h1 className="text-3xl font-bold">Meu perfil</h1><p className="mt-2 text-[var(--g-text-secondary)]">Sua apresentação e seus doces favoritos, do seu jeito.</p></header>
      <Card className="p-5 sm:p-6">
        <form onSubmit={save} className="space-y-6" aria-label="Editar perfil">
          <fieldset disabled={saving} className="space-y-5">
            <legend className="mb-4 text-xl font-semibold">Dados da conta</legend>
            <AvatarPicker id="profile-photo" label="Foto de perfil" savedUrl={removePhoto ? null : profile.avatarUrl} fallback={displayName[0] ?? ""} file={photo} disabled={saving}
              onChange={(file) => { changed(); uploaded.current = null; setPhoto(file); setRemovePhoto(file === null); }} />
            <Field id="profile-name" label="Nome de exibição"><Input id="profile-name" autoComplete="name" required minLength={2} maxLength={120} value={displayName} onChange={(event) => { changed(); setDisplayName(event.target.value); }} /></Field>
            <Field id="profile-username" label="Nome de usuário" description={`${USERNAME_RULE} Você também entra no Portal com ele.`} error={usernameError || undefined}>
              <Input id="profile-username" autoComplete="username" autoCapitalize="none" spellCheck={false} required minLength={3} maxLength={32} value={username}
                aria-invalid={usernameError ? true : undefined} aria-describedby={usernameError ? "profile-username-error" : "profile-username-description"}
                onChange={(event) => { changed(); setUsernameError(""); setUsername(event.target.value.toLowerCase()); }} />
            </Field>
            <Field id="profile-email" label="E-mail" description="O e-mail confirmado identifica sua conta e não pode ser alterado."><Input id="profile-email" value={profile.email} readOnly aria-readonly="true" aria-describedby="profile-email-description" /></Field>
          </fieldset>
          <fieldset disabled={saving} className="space-y-5">
            <legend className="mb-2 text-xl font-semibold">Mais sobre você · opcional</legend>
            <p className="text-sm text-[var(--g-text-secondary)]">Estes campos ficam visíveis apenas para você nesta versão. Você pode deixá-los em branco ou apagá-los quando quiser.</p>
            <Field id="profile-bio" label="Apresentação curta"><textarea id="profile-bio" rows={3} maxLength={280} value={bio} onChange={(event) => { changed(); setBio(event.target.value); }} className="w-full rounded-lg border border-[var(--g-border-default)] bg-[var(--g-surface-default)] p-3" /></Field>
            <Field id="profile-class" label="Turma ou grupo"><Input id="profile-class" maxLength={60} value={className} onChange={(event) => { changed(); setClassName(event.target.value); }} /></Field>
            <fieldset><legend className="font-semibold">Quais doces e sabores você gosta?</legend><p className="mt-1 text-sm text-[var(--g-text-secondary)]">Escolha até oito. São preferências de gosto; não representam restrições alimentares.</p>
              <div className="mt-3 flex flex-wrap gap-2">{sweetPreferences.map((sweet) => <label key={sweet} className="flex min-h-11 items-center gap-2 rounded-full border border-[var(--g-border-default)] px-3 text-sm"><input type="checkbox" checked={preferences.includes(sweet)} disabled={saving || (!preferences.includes(sweet) && preferences.length >= 8)} onChange={(event) => { changed(); setPreferences(event.target.checked ? [...preferences, sweet] : preferences.filter((value) => value !== sweet)); }} />{sweet}</label>)}</div>
            </fieldset>
          </fieldset>
          {notice && <p role="status" className="text-[var(--g-status-success-foreground)]">{notice}</p>}
          {error && <div role="alert" className="text-[var(--g-status-danger-foreground)]"><p>{error}</p><a href="/perfil" className="inline-flex min-h-11 items-center underline">Recarregar perfil</a></div>}
          <div className="flex flex-wrap items-center gap-4"><Button type="submit" loading={saving} disabled={saving}>Salvar perfil</Button><Link href="/trocar-senha" className="inline-flex min-h-11 items-center text-sm font-semibold text-[var(--g-brand-primary)]">Alterar senha</Link></div>
        </form>
      </Card>
    </div>
  </div>;
}
