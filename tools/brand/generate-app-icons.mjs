#!/usr/bin/env node
// Generates the Portal and PDV app icons from the official brand geometry (packages/ui/src/brand.ts). Every raster is
// rendered from the vector at its final size: nothing is ever upscaled from a smaller image.
//
//   pnpm brand:icons
//
// Output (committed): apps/<app>/public/icons/* and apps/<app>/app/favicon.ico. tools/brand/app-icons.test.ts checks
// that the committed files are exactly what this script renders.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { appIconSvg } from "../../packages/ui/src/brand.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every icon of one app: published name, shape and pixel size. */
export const APP_ICONS = [
  { file: "icon.svg", shape: "rounded" },
  { file: "icon-192.png", shape: "rounded", size: 192 },
  { file: "icon-512.png", shape: "rounded", size: 512 },
  { file: "icon-maskable-192.png", shape: "maskable", size: 192 },
  { file: "icon-maskable-512.png", shape: "maskable", size: 512 },
  { file: "apple-touch-icon.png", shape: "full", size: 180 },
];
export const FAVICON_SIZES = [16, 32, 48];

export async function renderPng(app, shape, size) {
  // density makes librsvg rasterize the 200-unit vector directly at the target size.
  return sharp(Buffer.from(appIconSvg(app, shape)), { density: (72 * size) / 200 })
    .resize(size, size)
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
}

/** A .ico holding PNG images (supported by every current browser), one per size. */
export async function renderIco(app) {
  const images = await Promise.all(FAVICON_SIZES.map((size) => renderPng(app, "full", size)));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(FAVICON_SIZES[index] % 256, entry);
    header.writeUInt8(FAVICON_SIZES[index] % 256, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  return Buffer.concat([header, ...images]);
}

export async function renderApp(app) {
  const files = new Map();
  for (const icon of APP_ICONS) {
    files.set(`public/icons/${icon.file}`, icon.size ? await renderPng(app, icon.shape, icon.size) : Buffer.from(appIconSvg(app, icon.shape)));
  }
  files.set("app/favicon.ico", await renderIco(app));
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const app of ["portal", "pdv"]) {
    for (const [path, content] of await renderApp(app)) {
      const target = join(root, "apps", app, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      console.log(`${app}: ${path} (${content.length} bytes)`);
    }
  }
}
