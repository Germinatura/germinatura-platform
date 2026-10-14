import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { appBrand, appManifestIcons, appPageIcons, type BrandApp } from "../../packages/ui/src/brand";
import { APP_ICONS, FAVICON_SIZES, renderApp } from "./generate-app-icons.mjs";

const apps: BrandApp[] = ["portal", "pdv"];
const committed = (app: BrandApp, path: string) => readFileSync(join("apps", app, path));
const rgb = (hex: string) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));

async function pixels(image: Buffer) {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

describe.each(apps)("app icons of %s", (app) => {
  it("are exactly what the generator renders from the official geometry (no hand-edited or upscaled raster)", async () => {
    for (const [path, rendered] of await renderApp(app)) {
      if (!path.endsWith(".png")) {
        expect(committed(app, path).equals(rendered), `${app}/${path}`).toBe(true);
        continue;
      }
      const [expected, actual] = await Promise.all([pixels(rendered), pixels(committed(app, path))]);
      expect([actual.width, actual.height], `${app}/${path}`).toEqual([expected.width, expected.height]);
      // librsvg anti-aliasing may differ by a unit between platforms; the drawing itself may not.
      const worst = expected.data.reduce((max, value, index) => Math.max(max, Math.abs(value - (actual.data[index] ?? 0))), 0);
      expect(worst, `${app}/${path}`).toBeLessThanOrEqual(2);
    }
  });

  it("have the declared sizes; maskable, Apple and favicon images are opaque, on the app's surface and mark colors", async () => {
    const { background, mark } = appBrand[app];
    for (const icon of APP_ICONS.filter((item) => item.size)) {
      const image = await pixels(committed(app, `public/icons/${icon.file}`));
      expect([image.width, image.height], icon.file).toEqual([icon.size, icon.size]);
      const at = (x: number, y: number) => Array.from(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));
      if (icon.shape !== "rounded") {
        expect(at(0, 0), `${icon.file} corner`).toEqual([...rgb(background), 255]);
        expect(at(image.width - 1, image.height - 1), `${icon.file} corner`).toEqual([...rgb(background), 255]);
      }
      expect(at(Math.round(image.width / 2), Math.round(image.height / 2)).slice(0, 3), `${icon.file} center`).toEqual(rgb(background));
      // A point inside the left block of the mark, at its center height.
      const block = at(Math.round(image.width * 0.38), Math.round(image.height * 0.5));
      expect(block.slice(0, 3), `${icon.file} mark`).toEqual(rgb(mark));
    }
    const ico = committed(app, "app/favicon.ico");
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(FAVICON_SIZES.length);
  });

  it("is what the manifest and the page head publish", async () => {
    const { default: manifest } = await import(`../../apps/${app}/app/manifest.ts`) as { default: () => { icons: Array<{ src: string; sizes: string; purpose: string }>; theme_color: string; background_color: string; short_name: string } };
    const published = manifest();
    expect(published.icons).toEqual([...appManifestIcons]);
    expect(published.theme_color).toBe(appBrand[app].theme);
    expect(published.background_color).toBe(appBrand[app].background);
    expect(published.icons.some((icon) => icon.purpose === "maskable" && icon.sizes === "512x512")).toBe(true);
    for (const icon of [...appManifestIcons.map((item) => item.src), ...appPageIcons.icon.map((item) => item.url), ...appPageIcons.apple.map((item) => item.url)]) {
      expect(existsSync(join("apps", app, "public", icon)), `${app}${icon}`).toBe(true);
    }
  });
});

it("Portal and PDV share the mark and differ by surface and color only", () => {
  expect(appBrand.portal.mark).not.toBe(appBrand.pdv.mark);
  expect(appBrand.portal.background).not.toBe(appBrand.pdv.background);
  expect(appBrand.portal.shortName).not.toBe(appBrand.pdv.shortName);
});
