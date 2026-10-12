export const PROFILE_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const PROFILE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/** Refuses what the profile-photos bucket does not accept, before anything is uploaded. */
export function profilePhotoProblem(file: File): string | null {
  if (!(PROFILE_PHOTO_TYPES as readonly string[]).includes(file.type)) return "Escolha uma imagem JPEG, PNG ou WebP.";
  if (file.size > PROFILE_PHOTO_MAX_BYTES) return "A imagem deve ter até 5 MB.";
  return null;
}

/** Scales the photo down to at most 512 px and re-encodes it as WebP (at most 1 MB), as the profile stores it. */
export async function prepareProfilePhoto(file: File): Promise<Blob> {
  const problem = profilePhotoProblem(file);
  if (problem) throw new Error(problem);
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
