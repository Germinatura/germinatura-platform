import { expect, test } from "@playwright/test";
import { expectApart, expectIconClearOfText, expectInside, expectNoHorizontalOverflow, layoutViewports } from "./support/layout";

const portal = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const headers = { Origin: portal, "Sec-Fetch-Site": "same-origin" };
const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

// Layout hardening: long names and descriptions never push actions or the page sideways, icons never cover text, and
// forms keep their controls inside the card, on phones, tablets and desktops.
test("as telas administrativas não transbordam nem sobrepõem controles em nenhum viewport", async ({ page }) => {
  test.setTimeout(600_000);
  const tag = Date.now().toString(36);
  const name = `Bolo de Pote Ninho com Morango e Creme Especial ${tag}`;
  const altText = "Bolo de pote brigadeiro com granulado de chocolate em embalagem transparente";
  expect((await page.request.post(`${portal}/api/auth/login`, { headers, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);

  // A product with a long name and one image with a long description.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${portal}/admin/catalogo`);
  await page.getByLabel("Nome", { exact: true }).fill(name);
  await page.getByLabel("Identificador", { exact: true }).fill(`e2e-layout-${tag}`);
  await page.getByLabel("Motivo", { exact: true }).fill("Cadastro para teste de layout");
  await page.getByRole("button", { name: "Criar produto", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Produto salvo");
  await page.goto(`${portal}/admin/catalogo?q=${tag}`);
  await page.getByRole("button", { name: `Editar imagens de ${name}` }).click();
  await page.getByLabel("Motivo da alteração").fill("Foto para teste de layout");
  await page.getByLabel("Descrição acessível").fill(altText);
  await page.getByLabel("Arquivo JPG, PNG ou WebP").setInputFiles({ name: "layout.png", mimeType: "image/png", buffer: Buffer.from(pixel, "base64") });
  await page.getByRole("button", { name: "Enviar imagem" }).click();
  const images = page.getByRole("list", { name: "Imagens do produto" });
  await expect(images.getByRole("listitem")).toHaveCount(1);

  for (const viewport of layoutViewports) {
    const label = `${viewport.width}×${viewport.height}`;
    await page.setViewportSize(viewport);

    // Product images: the description never runs under the actions, and the actions stay inside the row.
    const row = images.getByRole("listitem").first();
    await expect(row.getByText(altText)).toBeVisible();
    await expectApart(row.getByText(altText), row.getByRole("button", { name: /^Remover/ }), `imagens ${label}`);
    await expectInside(row, row.getByRole("button"), `ações da imagem ${label}`);
    await expectNoHorizontalOverflow(page, `imagens ${label}`);
  }

  const screens: Array<{ path: string; ready: RegExp; check?: (label: string) => Promise<void> }> = [
    { path: "/admin/usuarios", ready: /Usuários/, check: async (label) => {
      const group = page.locator(".g-input-group").filter({ has: page.getByPlaceholder("Nome, e-mail, usuário ou papel") });
      await expectIconClearOfText(group, `busca de usuários ${label}`);
      await group.locator(".g-input-group__icon").click({ force: true });
      await expect(page.getByPlaceholder("Nome, e-mail, usuário ou papel")).toBeFocused();
    } },
    { path: "/admin/estoque", ready: /Perdas de estoque/, check: async (label) => {
      const form = page.getByRole("form", { name: "Configurar aprovação de perdas" });
      await expectInside(form, form.locator("input, button"), `limite de perdas ${label}`);
      await expectApart(form.getByLabel("Limite automático"), form.getByLabel("Justificativa"), `limite × justificativa ${label}`);
      await expectApart(form.getByLabel("Justificativa"), form.getByRole("button", { name: "Salvar limite" }), `justificativa × salvar ${label}`);
      await expect(form.getByText("Mínimo de 4 caracteres.")).toBeVisible();
    } },
    { path: `/admin/catalogo?q=${tag}`, ready: new RegExp(name) },
    { path: "/admin/financeiro/conciliacao-picpay", ready: /Resumo da conciliação|Período/ },
  ];
  for (const screen of screens) {
    for (const viewport of layoutViewports) {
      const label = `${screen.path} ${viewport.width}×${viewport.height}`;
      await page.setViewportSize(viewport);
      await page.goto(`${portal}${screen.path}`);
      await expect(page.getByText(screen.ready).first()).toBeVisible({ timeout: 90_000 });
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await expectNoHorizontalOverflow(page, label);
      await screen.check?.(label);
    }
  }

  // Clean up the image so other suites see the catalog as they expect.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${portal}/admin/catalogo?q=${tag}`);
  await page.getByRole("button", { name: `Editar imagens de ${name}` }).click();
  await page.getByLabel("Motivo da alteração").fill("Remover foto de layout");
  await page.getByRole("button", { name: "Remover capa" }).click();
  await expect(page.getByText("Este produto ainda não tem imagem.")).toBeVisible();
});
