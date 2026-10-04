export const CATALOG_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export type CatalogImageFileType = { extension: "jpg" | "png" | "webp"; mimeType: "image/jpeg" | "image/png" | "image/webp" };

export function detectCatalogImageFile(bytes: Uint8Array): CatalogImageFileType | null {
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { extension: "webp", mimeType: "image/webp" };
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { extension: "png", mimeType: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: "jpg", mimeType: "image/jpeg" };
  }
  return null;
}

export function storageConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = "statusCode" in error ? String(error.statusCode) : "";
  const message = "message" in error ? String(error.message) : "";
  return status === "409" || /already exists|duplicate/i.test(message);
}
