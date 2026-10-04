"use client";

import Link from "next/link";
import Image from "next/image";
import { useRef, useState } from "react";
import { Button, Card, Field, Input } from "@germinatura/ui";
import { privateProfileSchema, sweetPreferences, updateProfileSchema, type PrivateProfile } from "@germinatura/contracts";
import { getPortalSupabaseBrowserClient } from "@/lib/supabase/browser";

async function preparePhoto(file: File) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
    throw new Error("Escolha uma foto JPEG, PNG ou WebP de até 5 MB.");
  }
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error("Não foi possível abrir esta foto. Escolha outra imagem JPEG, PNG ou WebP."); });
  try {
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Não foi possível preparar a foto.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
      if (blob && blob.size <= 1024 * 1024) resolve(blob);
      else reject(new Error("Não foi possível reduzir a foto. Escolha outra imagem."));
    }, "image/webp", 0.85));
  } finally { bitmap.close(); }
}

export function ProfileEditor({ initial }: { initial: PrivateProfile }) {
  const [profile, setProfile] = useState(initial);
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [bio, setBio] = useState(initial.bio);
  const [className, setClassName] = useState(initial.className);
  const [preferences, setPreferences] = useState(initial.sweetPreferences);
  const [photo, setPhoto] = useState<File | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [photoGeneration, setPhotoGeneration] = useState(0);
  const submitting = useRef(false);
  const key = useRef<string | null>(null);
  const uploaded = useRef<{ file: File; path: string } | null>(null);
  const changed = () => { key.current = null; setNotice(""); setError(""); };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true; setSaving(true); setError(""); setNotice("");
    try {
      let avatarPath = removePhoto ? null : profile.avatarPath;
      if (photo && !removePhoto) {
        if (uploaded.current?.file !== photo) {
          const blob = await preparePhoto(photo);
          const path = `${profile.id}/${crypto.randomUUID()}.webp`;
          const { error: uploadError } = await getPortalSupabaseBrowserClient().storage.from("profile-photos").upload(path, blob, { contentType: "image/webp", upsert: false });
          if (uploadError) throw new Error("Não foi possível enviar a foto. Tente novamente.");
          uploaded.current = { file: photo, path };
        }
        avatarPath = uploaded.current.path;
      }
      const input = updateProfileSchema.parse({ expectedRevision: profile.revision, displayName, avatarPath, bio, className, sweetPreferences: preferences });
      key.current ??= `profile:${crypto.randomUUID()}`;
      const response = await fetch("/api/v1/profile", { method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": key.current }, body: JSON.stringify(input) });
      const body = await response.json() as { data?: unknown; message?: string };
      if (!response.ok) throw new Error(body.message ?? "Não foi possível salvar o perfil.");
      const saved = privateProfileSchema.parse(body.data);
      setProfile(saved); setDisplayName(saved.displayName); setBio(saved.bio); setClassName(saved.className); setPreferences(saved.sweetPreferences);
      setPhoto(null); setRemovePhoto(false); uploaded.current = null; key.current = null; setPhotoGeneration((value) => value + 1);
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
            <div className="flex flex-wrap items-center gap-4">
              {profile.avatarUrl && !removePhoto ? <Image unoptimized src={profile.avatarUrl} width={80} height={80} alt="Sua foto de perfil" className="size-20 rounded-full object-cover" /> : <span className="flex size-20 items-center justify-center rounded-full bg-[var(--g-brand-primary-soft)] text-2xl font-bold text-[var(--g-brand-primary)]" aria-label="Perfil sem foto">{displayName[0]?.toUpperCase()}</span>}
              <div className="min-w-0 flex-1"><Field id="profile-photo" label="Foto de perfil" description="JPEG, PNG ou WebP, até 5 MB. A imagem será reduzida antes do envio."><Input key={photoGeneration} id="profile-photo" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { changed(); setPhoto(event.target.files?.[0] ?? null); setRemovePhoto(false); uploaded.current = null; }} /></Field></div>
            </div>
            {(profile.avatarPath || photo) && <Button type="button" variant="secondary" onClick={() => { changed(); setRemovePhoto(true); setPhoto(null); setPhotoGeneration((value) => value + 1); }}>Remover foto</Button>}
            <Field id="profile-name" label="Nome de exibição"><Input id="profile-name" autoComplete="name" required minLength={2} maxLength={120} value={displayName} onChange={(event) => { changed(); setDisplayName(event.target.value); }} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="profile-email" label="E-mail"><Input id="profile-email" value={profile.email} readOnly /></Field>
              <Field id="profile-username" label="Nome de usuário"><Input id="profile-username" value={profile.username} readOnly /></Field>
            </div>
            <p className="text-sm text-[var(--g-text-secondary)]">O e-mail e o nome de usuário identificam seu acesso e não são alterados neste formulário.</p>
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
