import { expect, test } from "@playwright/test";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const TURMA_2026 = "c0000000-0000-4000-8000-000000002026";

// E0 (ADR 0011): the PicPay account is shared. ADMIN_MASTER imports a mixed file (it stays without a cohort), attributes
// it to Turma 2026 after a preview; activating isolation is ADMIN_MASTER's and definitive (it is not activated here, so the
// shared database keeps its state: the activation itself is covered by pgTAP). A cohort ADMIN never imports nor attributes.
test("ADMIN_MASTER importa um extrato misto, atribui à turma após a prévia e só ele ativa o isolamento", async ({ page, browser }) => {
  test.slow();
  const tag = Date.now().toString(36);
  const base = 100_000 + (Date.now() % 800_000);
  const day = "2025-05-20";
  const money = (cents: number) => `-${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
  const content = ["data;movimento;descrição;tipo;valor",
    `${day};Pix enviado;Fornecedor ${tag} A;Saída;${money(base)};`, `${day};Pix enviado;Fornecedor ${tag} B;Saída;${money(base + 1)};`].join("\r\n");

  // A cohort ADMIN: no import form and no access to the attribution.
  const admin = await browser.newPage();
  expect((await admin.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl },
    data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  expect((await admin.request.get(`${portalUrl}/api/v1/admin/finance/picpay/attribution`)).status()).toBe(403);
  const refused = await admin.request.post(`${portalUrl}/api/v1/admin/finance/picpay/files?fileName=x.csv&scope=GLOBAL`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-attribution-admin-${tag}`, "Content-Type": "text/csv" }, data: Buffer.from(content),
  });
  expect(refused.status()).toBe(403);
  expect((await admin.request.post(`${portalUrl}/api/v1/admin/finance/picpay/attribution/isolation`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-isolation-admin-${tag}` }, data: { reason: "Tentativa de ADMIN de turma" },
  })).status()).toBe(403);
  await admin.goto(`${portalUrl}/admin/financeiro/conciliacao-picpay`);
  await expect(admin.getByText(/os arquivos são importados pelo ADMIN_MASTER/)).toBeVisible({ timeout: 90_000 });
  await expect(admin.getByLabel("Arquivos CSV")).toHaveCount(0);
  await admin.close();

  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl },
    data: { identifier: "master.teste", password: "Master123!" } })).status()).toBe(200);
  expect((await page.request.post(`${portalUrl}/api/v1/session/cohort`, { headers: { Origin: portalUrl }, data: { cohort: TURMA_2026 } })).status()).toBe(200);
  for (const request of [
    page.request.get(`${portalUrl}/api/v1/admin/finance/picpay/attribution`),
    page.request.post(`${portalUrl}/api/v1/admin/finance/picpay/attribution/preview`, { headers: { Origin: portalUrl } }),
  ]) expect((await request).status()).toBeLessThan(500);
  // The declaration is mandatory.
  expect((await page.request.post(`${portalUrl}/api/v1/admin/finance/picpay/files?fileName=sem-declaracao.csv`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-attribution-none-${tag}`, "Content-Type": "text/csv" }, data: Buffer.from(content),
  })).status()).toBe(422);

  await page.goto(`${portalUrl}/admin/financeiro/conciliacao-picpay`);
  const attribution = page.getByRole("region", { name: "Atribuição da evidência PicPay" });
  await expect(attribution.getByText(/Isolamento (ativo|ainda não ativado)/)).toBeVisible({ timeout: 90_000 });
  const files = page.getByRole("region", { name: "Importar arquivos" });
  await page.getByLabel("Arquivos CSV").setInputFiles({ name: `misto-${tag}.csv`, mimeType: "text/csv", buffer: Buffer.from(content) });
  const row = files.getByRole("row").filter({ hasText: `misto-${tag}.csv` });
  await expect(row.getByText("Pronto para importar")).toBeVisible();
  await files.getByLabel(/Misto ou de origem incerta/).check();
  await files.getByRole("button", { name: "Importar arquivos" }).click();
  await expect(row.getByText(/Sem turma até ser atribuído\./)).toBeVisible();
  const number = Number((await row.getByText(/Importado como arquivo nº/).textContent())?.match(/nº (\d+)/)?.[1]);

  // The file is mixed: both lines wait without a cohort until ADMIN_MASTER attributes them.
  const fileRow = attribution.getByRole("row").filter({ hasText: `nº ${number} ` });
  await expect(fileRow.getByText("Misto/global")).toBeVisible();
  await expect(fileRow.getByText(/^2 · /)).toBeVisible();
  await fileRow.getByRole("button", { name: "Arquivo inteiro" }).click();
  const confirm = attribution.getByRole("group", { name: "Confirmar atribuição" });
  await expect(confirm).toContainText("2 item(ns) (2 linha(s) do Extrato, 0 venda(s))");
  await expect(confirm.getByRole("button", { name: "Confirmar atribuição" })).toBeDisabled();
  await confirm.getByLabel("Motivo da atribuição").fill(`Arquivo misto ${tag} conferido: só Turma 2026`);
  await confirm.getByRole("button", { name: "Confirmar atribuição" }).click();
  await expect(page.getByText(/2 item\(ns\) atribuído\(s\) à/)).toBeVisible();
  await expect(fileRow.getByText(/^0 · /)).toBeVisible();

  // Isolation: there is no way to turn it off; before activation the button waits for a reason and warns it is definitive.
  await expect(attribution.getByRole("button", { name: /Desligar|Desativar/ })).toHaveCount(0);
  const active = (await (await page.request.get(`${portalUrl}/api/v1/admin/finance/picpay/attribution`)).json() as { data: { enforced: boolean } }).data.enforced;
  if (!active) {
    await expect(attribution.getByText(/A ativação é definitiva/)).toBeVisible();
    await expect(attribution.getByRole("button", { name: "Ativar isolamento" })).toBeDisabled();
  }
  expect((await page.request.put(`${portalUrl}/api/v1/admin/finance/picpay/attribution/isolation`, {
    headers: { Origin: portalUrl }, data: { reason: "Tentativa de desligar" },
  })).status()).toBe(405);
});
