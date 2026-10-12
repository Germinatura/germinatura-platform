import { expect, test, type Page } from "@playwright/test";
import { expectInside, expectNoHorizontalOverflow } from "./support/layout";
import { latestEmailCode } from "./support/mailbox";

const portal = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const headers = { Origin: portal, "Sec-Fetch-Site": "same-origin" };
const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGNkENnCgA0wYRUdtBIAoQQA2C9kUJoAAAAASUVORK5CYII=";
const narrowViewports = [{ width: 320, height: 640 }, { width: 360, height: 740 }, { width: 390, height: 844 }] as const;

async function expectCardFits(page: Page, label: string) {
  await expectNoHorizontalOverflow(page, label);
  const card = page.locator("main > section");
  await expectInside(card, card.locator("input:not(.sr-only), button, [role=alert], p, span"), label);
}

/** A brand-new consumer account, so the fixtures' usernames stay untouched. */
async function signUpThroughApi(page: Page) {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const account = { email: `perfil.e2e.${suffix}@institutojef.org.br`, username: `perfil.${suffix}`, password: "Perfil123!" };
  expect((await page.request.post("/api/v1/auth/signup/request", { headers, data: { email: account.email } })).status()).toBe(202);
  const token = await latestEmailCode(page.request, account.email);
  expect((await page.request.post("/api/v1/auth/signup/verify", { headers, data: { email: account.email, token } })).status()).toBe(200);
  expect((await page.request.post("/api/v1/auth/signup/complete", { headers,
    data: { displayName: "Pessoa Perfil E2E", username: account.username, password: account.password, avatarPath: null } })).status()).toBe(200);
  return account;
}

// A3: the sign-up fits 320, 360 and 390 px screens; the photo uses a picker with name, preview, replace and remove.
test("o cadastro cabe em 320, 360 e 390 px e o seletor de foto substitui o campo de arquivo cru", async ({ page }) => {
  const suffix = Date.now().toString(36);
  const email = `mobile.e2e.${suffix}@institutojef.org.br`;
  await page.setViewportSize(narrowViewports[0]);
  await page.goto("/cadastro");
  for (const viewport of narrowViewports) {
    await page.setViewportSize(viewport);
    await expectCardFits(page, `/cadastro ${viewport.width}px`);
  }
  await page.getByLabel("E-mail institucional").fill(email);
  await page.getByRole("button", { name: "Enviar código" }).click();
  await page.getByLabel("Código de 6 a 10 dígitos").fill(await latestEmailCode(page.request, email));
  await page.getByRole("button", { name: "Confirmar código" }).click();
  await expect(page).toHaveURL(`${portal}/cadastro/perfil`);
  await expect(page.locator('form[data-hydrated="true"]')).toBeVisible();

  // The raw file input is gone from view: a button opens it, and the chosen file shows its name and a preview.
  // Visually hidden (sr-only, 1 px), never the browser's own file control.
  await expect(page.locator('input[type="file"]')).toHaveClass(/sr-only/);
  expect((await page.locator('input[type="file"]').boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: "Selecionar imagem" })).toBeVisible();
  await page.locator("#signup-photo").setInputFiles({ name: "uma-foto-com-um-nome-de-arquivo-bem-comprido-para-quebrar-linha.png", mimeType: "image/png", buffer: Buffer.from(pixel, "base64") });
  await expect(page.getByText("uma-foto-com-um-nome-de-arquivo-bem-comprido-para-quebrar-linha.png")).toBeVisible();
  await expect(page.getByRole("img", { name: "Prévia da nova foto de perfil" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Trocar imagem" })).toBeVisible();
  await page.locator("#signup-photo").setInputFiles({ name: "notas.txt", mimeType: "text/plain", buffer: Buffer.from("texto") });
  await expect(page.getByRole("alert").filter({ hasText: "Escolha uma imagem" })).toHaveText("Escolha uma imagem JPEG, PNG ou WebP.");
  await expect(page.getByRole("img", { name: "Prévia da nova foto de perfil" })).toBeVisible();

  await page.getByLabel("Nome", { exact: true }).fill("Pessoa Com Um Nome Bastante Comprido Para Testar Quebra");
  await page.getByLabel("Senha", { exact: true }).fill("Mobile123!");
  await page.getByLabel("Confirmar senha").fill("Mobile123!");
  // Someone else's username: the answer is clear and stays on the field.
  await page.getByLabel("Nome de usuário").fill("vendedor.teste");
  await page.getByRole("button", { name: "Concluir cadastro" }).click();
  await expect(page.getByText("Este nome de usuário já está em uso. Escolha outro.")).toBeVisible();
  await expect(page.getByLabel("Nome de usuário")).toBeFocused();
  for (const viewport of narrowViewports) {
    await page.setViewportSize(viewport);
    await expectCardFits(page, `/cadastro/perfil ${viewport.width}px`);
  }
  await page.getByRole("button", { name: "Remover" }).click();
  await expect(page.getByText("Nenhuma foto escolhida")).toBeVisible();
  await page.locator("#signup-photo").setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: Buffer.from(pixel, "base64") });

  await page.getByLabel("Nome de usuário").fill(`mobile.${suffix}`);
  await page.getByRole("button", { name: "Concluir cadastro" }).click();
  await expect(page).toHaveURL(`${portal}/`, { timeout: 45_000 });
  const profile = await (await page.request.get("/api/v1/profile")).json() as { data: { username: string; avatarPath: string | null } };
  expect(profile.data.username).toBe(`mobile.${suffix}`);
  expect(profile.data.avatarPath).toMatch(/\.webp$/);
});

// A2: the username can change after onboarding, with the sign-up rule; the confirmed e-mail cannot.
test("a pessoa troca o nome de usuário; o login segue o novo e o e-mail continua o mesmo", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const account = await signUpThroughApi(page);
  await page.goto("/perfil");
  await expect(page.getByLabel("E-mail")).toHaveValue(account.email);
  await expect(page.getByLabel("E-mail")).not.toBeEditable();
  await expect(page.getByLabel("Nome de usuário")).toHaveValue(account.username);

  await page.getByLabel("Nome de usuário").fill("admin.teste");
  await page.getByRole("button", { name: "Salvar perfil" }).click();
  await expect(page.getByText("Este nome de usuário já está em uso. Escolha outro.")).toBeVisible();
  await page.getByLabel("Nome de usuário").fill("9invalido");
  await page.getByRole("button", { name: "Salvar perfil" }).click();
  await expect(page.locator("#profile-username-error")).toContainText("comece com uma letra");

  const renamed = `${account.username}.novo`;
  await page.getByLabel("Nome de usuário").fill(renamed.toUpperCase());
  await expect(page.getByLabel("Nome de usuário")).toHaveValue(renamed);
  await page.getByRole("button", { name: "Salvar perfil" }).click();
  await expect(page.getByRole("status")).toHaveText("Perfil atualizado.");
  await expectNoHorizontalOverflow(page, "/perfil 390px");
  await page.reload();
  await expect(page.getByLabel("Nome de usuário")).toHaveValue(renamed);

  const session = await (await page.request.get("/api/v1/auth/session")).json() as { user: { email: string; username: string } };
  expect(session.user).toMatchObject({ email: account.email, username: renamed });
  // The e-mail is not part of the editable profile: an attempt to send it is refused as a whole.
  const current = await (await page.request.get("/api/v1/profile")).json() as { data: { revision: number; displayName: string; username: string } };
  const body = { expectedRevision: current.data.revision, displayName: current.data.displayName, username: current.data.username, avatarPath: null, bio: "", className: "", sweetPreferences: [] };
  expect((await page.request.patch("/api/v1/profile", { headers: { ...headers, "Idempotency-Key": `email:${crypto.randomUUID()}` },
    data: { ...body, email: `outra.${Date.now()}@institutojef.org.br` } })).status()).toBe(422);

  await page.request.post("/api/auth/logout", { headers });
  expect((await page.request.post("/api/auth/login", { headers, data: { identifier: account.username, password: account.password } })).status()).not.toBe(200);
  expect((await page.request.post("/api/auth/login", { headers, data: { identifier: renamed, password: account.password } })).status()).toBe(200);
  expect((await page.request.post("/api/auth/login", { headers, data: { identifier: account.email, password: account.password } })).status()).toBe(200);
});
