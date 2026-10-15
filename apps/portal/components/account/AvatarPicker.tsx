"use client";

import Image from "next/image";
import { useId, useRef, useState } from "react";
import { Button } from "@germinatura/ui";
import { profilePhotoProblem } from "@/lib/profile-photo";

interface AvatarPickerProps {
  /** id of the (visually hidden) file input, for labels and tests. */
  id: string;
  label: string;
  /** Photo already saved, shown until another one is chosen or it is removed. */
  savedUrl: string | null;
  /** Letter shown when there is no photo. */
  fallback: string;
  file: File | null;
  /** A new valid file, or null when the person removes the photo. */
  onChange: (file: File | null) => void;
  disabled?: boolean;
}

/**
 * Profile photo chooser: a button instead of the raw file input, the chosen file's name, a preview, and replace/remove.
 * The row follows its own width (g-media-row), so it never pushes the card wider on a 320 px screen.
 */
export function AvatarPicker({ id, label, savedUrl, fallback, file, onChange, disabled }: AvatarPickerProps) {
  const input = useRef<HTMLInputElement>(null);
  // The preview belongs to the file it was read from: once the parent clears or replaces the file, it is not shown.
  const [read, setRead] = useState<{ file: File; url: string } | null>(null);
  const [error, setError] = useState("");
  const describedBy = useId();

  const preview = read && read.file === file ? read.url : null;
  const shown = preview ?? (file ? null : savedUrl);
  const hasPhoto = file !== null || shown !== null;

  return <div className="g-field min-w-0" role="group" aria-labelledby={`${id}-label`}>
    <span className="g-label" id={`${id}-label`}>{label}</span>
    <div className="g-media-row">
      <div className="g-media-row__inner">
        <div className="g-media-row__media">
          {shown
            ? <Image unoptimized src={shown} width={72} height={72} alt={preview ? "Prévia da nova foto de perfil" : "Sua foto de perfil"} className="size-18 rounded-full object-cover" />
            : <span aria-hidden="true" className="flex size-18 items-center justify-center rounded-full bg-[var(--g-brand-primary-soft)] text-2xl font-bold text-[var(--g-brand-primary)]">{fallback.toUpperCase() || "?"}</span>}
        </div>
        <div className="g-media-row__body text-sm" id={describedBy}>
          <p className="font-semibold text-[var(--g-text-primary)]">{file ? file.name : hasPhoto ? "Foto atual" : "Nenhuma foto escolhida"}</p>
          <p className="mt-1 text-[var(--g-text-muted)]">JPEG, PNG ou WebP, até 5 MB. A imagem é reduzida antes do envio.</p>
        </div>
        <div className="g-media-row__actions">
          <Button type="button" variant="secondary" disabled={disabled} aria-describedby={describedBy} onClick={() => input.current?.click()}>
            {hasPhoto ? "Trocar imagem" : "Selecionar imagem"}
          </Button>
          {hasPhoto && <Button type="button" variant="secondary" disabled={disabled} onClick={() => { setError(""); onChange(null); }}>Remover</Button>}
        </div>
      </div>
    </div>
    <input ref={input} id={id} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" tabIndex={-1} aria-hidden="true" disabled={disabled}
      onChange={(event) => {
        const chosen = event.target.files?.[0] ?? null;
        event.target.value = "";
        if (!chosen) return;
        const problem = profilePhotoProblem(chosen);
        setError(problem ?? "");
        if (problem) return;
        const reader = new FileReader();
        reader.onload = () => { if (typeof reader.result === "string") setRead({ file: chosen, url: reader.result }); };
        reader.readAsDataURL(chosen);
        onChange(chosen);
      }} />
    {error && <p className="g-field__error" role="alert">{error}</p>}
  </div>;
}
