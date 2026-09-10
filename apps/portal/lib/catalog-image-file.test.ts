import { describe, expect, it } from "vitest";
import { detectCatalogImageFile, storageConflict } from "./catalog-image-file";

describe("catalog image validation", () => {
  it("detects supported signatures independently of the supplied filename", () => {
    expect(detectCatalogImageFile(Uint8Array.from([0xff, 0xd8, 0xff]))?.extension).toBe("jpg");
    expect(detectCatalogImageFile(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.extension).toBe("png");
    expect(detectCatalogImageFile(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]))?.extension).toBe("webp");
    expect(detectCatalogImageFile(Uint8Array.from([1, 2, 3, 4]))).toBeNull();
  });

  it("recognizes an idempotent duplicate upload", () => {
    expect(storageConflict({ statusCode: "409", message: "The resource already exists" })).toBe(true);
    expect(storageConflict({ statusCode: "400", message: "Invalid" })).toBe(false);
  });
});
