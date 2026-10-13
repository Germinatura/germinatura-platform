import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const apps = [
  { name: "Portal", origin: process.env.PORTAL_URL ?? "http://127.0.0.1:3000", path: "/login", theme: "#001EC5", shortName: "Germinatura" },
  { name: "PDV", origin: process.env.PDV_URL ?? "http://127.0.0.1:3001", path: "/login", theme: "#070B18", shortName: "PDV" },
];

// B: each app is installable with its own icons, rendered from the official mark, all reachable before any sign-in.
for (const app of apps) {
  test(`${app.name}: manifest, ícones, apple-touch-icon e theme-color públicos e coerentes`, async ({ page, request }) => {
    const manifest = await request.get(`${app.origin}/manifest.webmanifest`, { maxRedirects: 0 });
    expect(manifest.status()).toBe(200);
    const body = await manifest.json() as { short_name: string; theme_color: string; display: string; icons: Array<{ src: string; sizes: string; type: string; purpose: string }> };
    expect(body).toMatchObject({ short_name: app.shortName, theme_color: app.theme, display: "standalone" });
    expect(body.icons.filter((icon) => icon.type === "image/png").map((icon) => `${icon.sizes}:${icon.purpose}`).sort())
      .toEqual(["192x192:any", "192x192:maskable", "512x512:any", "512x512:maskable"]);
    for (const icon of [...body.icons.map((item) => item.src), "/icons/apple-touch-icon.png", "/favicon.ico"]) {
      const response = await request.get(`${app.origin}${icon}`, { maxRedirects: 0 });
      expect(response.status(), icon).toBe(200);
      expect(response.headers()["content-type"], icon).toMatch(/^image\//);
    }

    await page.goto(`${app.origin}${app.path}`);
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/icons/apple-touch-icon.png");
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", app.theme);
    expect(await page.locator('link[rel="icon"]').evaluateAll((links) => links.map((link) => link.getAttribute("href"))))
      .toEqual(expect.arrayContaining(["/icons/icon.svg", "/icons/icon-192.png"]));

    // What Chromium itself decides about installing the app (the criteria behind "Instalar app" / "Adicionar à tela inicial").
    const cdp = await page.context().newCDPSession(page);
    await expect.poll(async () => (await cdp.send("Page.getAppManifest")).errors.length === 0 && Boolean((await cdp.send("Page.getAppManifest")).url)).toBe(true);
    const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
    expect(installabilityErrors).toEqual([]);
  });
}

// The PDV's own surfaces keep WCAG contrast (a brand-blue link on the dark card read at 1.68:1) and its offline shell
// shows the PDV variant of the mark.
test("PDV: links das telas de acesso com contraste e marca offline na variante do PDV", async ({ page, request }) => {
  const pdv = process.env.PDV_URL ?? "http://127.0.0.1:3001";
  await page.goto(`${pdv}/acesso`);
  await expect(page.getByRole("link", { name: "Entrar com usuário e senha" })).toBeVisible({ timeout: 15_000 });
  const contrast = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
  expect(contrast.violations.map((violation) => violation.nodes.map((node) => node.target.join(" "))).flat()).toEqual([]);
  const brand = await (await request.get(`${pdv}/offline/brand.svg`)).text();
  expect(brand).toContain('fill="#070B18"');
  expect(brand).toContain('fill="#00B982"');
});
