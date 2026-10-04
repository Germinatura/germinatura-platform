import { expect, test } from "@playwright/test";

const portal = "http://127.0.0.1:3000";

test("administração cadastra, edita e inativa fornecedor pela jornada completa", async ({ browser }) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const originalName = `Fornecedor E2E ${suffix}`;
  const updatedName = `Fornecedor E2E atualizado ${suffix}`;
  const document = `E2E${suffix.replaceAll("-", "").toUpperCase()}`;
  const admin = await browser.newContext();
  try {
    const page = await admin.newPage();
    expect((await page.request.post(`${portal}/api/auth/login`, {
      headers: { Origin: portal, "Sec-Fetch-Site": "same-origin" },
      data: { identifier: "admin.teste", password: "Admin123!" },
    })).status()).toBe(200);

    await page.goto(`${portal}/admin/compras`);
    await expect(page.getByRole("heading", { name: "Fornecedores", exact: true })).toBeVisible();
    await page.getByLabel("Nome").fill(originalName);
    await page.getByLabel("Pessoa de contato").fill("Equipe comercial");
    await page.getByLabel("E-mail").fill("compras@example.com");
    await page.getByLabel("Telefone").fill("11999990000");
    await page.getByLabel("Documento opcional").fill(document);
    await page.getByLabel("Observação opcional").fill("Entrega agendada para o estoque central");
    await page.getByLabel("Motivo").fill("Homologar fornecedor para compras");
    const createdPromise = page.waitForResponse((response) => response.url().endsWith("/api/v1/admin/procurement/suppliers") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Cadastrar fornecedor" }).click();
    expect((await createdPromise).status()).toBe(201);
    await expect(page.getByText(originalName, { exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("Fornecedor cadastrado");

    const row = page.getByRole("listitem").filter({ hasText: originalName });
    await row.getByRole("button", { name: `Editar fornecedor ${originalName}` }).click();
    await page.getByLabel("Nome").fill(updatedName);
    await page.getByLabel("Fornecedor ativo para novas compras").uncheck();
    await page.getByLabel("Motivo").fill("Inativar após conferência do cadastro");
    const updatedPromise = page.waitForResponse((response) => response.url().endsWith("/api/v1/admin/procurement/suppliers") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Salvar fornecedor" }).click();
    expect((await updatedPromise).status()).toBe(200);
    const updatedRow = page.getByRole("listitem").filter({ hasText: updatedName });
    await expect(updatedRow).toBeVisible();
    await expect(updatedRow.getByText("Inativo", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await admin.close();
  }
});

test("consumidor não acessa fornecedores pela página nem pela API", async ({ browser }) => {
  const consumer = await browser.newContext();
  try {
    const page = await consumer.newPage();
    expect((await page.request.post(`${portal}/api/auth/login`, {
      headers: { Origin: portal, "Sec-Fetch-Site": "same-origin" },
      data: { identifier: "consumidor.teste", password: "Consumidor123!" },
    })).status()).toBe(200);
    expect((await page.request.get(`${portal}/api/v1/admin/procurement/suppliers`)).status()).toBe(403);
    expect((await page.request.post(`${portal}/api/v1/admin/procurement/suppliers`, {
      headers: { Origin: portal, "Sec-Fetch-Site": "same-origin", "Idempotency-Key": `consumer-supplier:${crypto.randomUUID()}` },
      data: { id: null, expectedRevision: null, name: "Tentativa negada", contactName: "Contato", email: null, phone: null, document: null, notes: null, active: true, reason: "Tentativa sem acesso" },
    })).status()).toBe(403);
    await page.goto(`${portal}/admin/compras`);
    await expect(page).toHaveURL(`${portal}/`);
  } finally {
    await consumer.close();
  }
});
