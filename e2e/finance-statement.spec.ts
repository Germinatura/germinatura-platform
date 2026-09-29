import { expect, test } from "@playwright/test";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";

test("financeiro vê o extrato consolidado e exporta um CSV real", async ({ page }) => {
  test.slow();
  const tag = Date.now().toString(36);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl },
    data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  const recorded = await page.request.post(`${portalUrl}/api/v1/admin/finance/entries`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-statement-${tag}` },
    data: { kind: "EXPENSE", category: "MATERIAIS", account: "PICPAY_EMPRESAS", counterAccount: null, amountCents: 1_234,
      occurredOn: today, description: `Faixas do evento ${tag}`, reference: `NF-${tag}` },
  });
  expect(recorded.status()).toBe(201);

  await page.goto(`${portalUrl}/admin/financeiro/extrato`);
  const row = page.getByRole("row").filter({ hasText: `Faixas do evento ${tag}` });
  await expect(row).toBeVisible();
  await expect(row.getByText("Materiais")).toBeVisible();
  await expect(row.getByText("-R$ 12,34")).toBeVisible();
  await expect(page.getByRole("list", { name: "Resultado por categoria" }).getByText("Materiais")).toBeVisible();

  const csv = await page.request.get(`${portalUrl}/api/v1/admin/finance/statement?from=${today}&to=${today}&format=csv`);
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(csv.headers()["content-disposition"]).toContain(`extrato-${today}-a-${today}.csv`);
  const text = await csv.text();
  expect(text.startsWith(`${String.fromCharCode(0xfeff)}data;origem;categoria;conta;valor_reais;descricao;referencia\r\n`)).toBe(true);
  expect(text).toContain(`${today};Manual;MATERIAIS;PICPAY_EMPRESAS;-12,34;Faixas do evento ${tag};NF-${tag}\r\n`);
});
