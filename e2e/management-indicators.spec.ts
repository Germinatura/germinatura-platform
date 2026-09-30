import { expect, test } from "@playwright/test";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

test("o financeiro consulta indicadores do período derivados dos lançamentos; o vendedor não", async ({ page, browser }) => {
  test.slow();
  // Sellers never reach the management figures.
  const seller = await browser.newContext({ baseURL: portalUrl });
  expect((await seller.request.post("/api/auth/login", { headers: { Origin: portalUrl }, data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
  expect((await seller.request.get(`/api/v1/admin/finance/indicators?from=${today()}&to=${today()}`)).status()).toBe(403);
  await seller.close();

  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl }, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  const from = `${today().slice(0, 8)}01`;
  const response = await page.request.get(`${portalUrl}/api/v1/admin/finance/indicators?from=${from}&to=${today()}`);
  expect(response.status()).toBe(200);
  const { data } = await response.json() as { data: { totals: Record<string, number | boolean | null>; byChannel: Record<string, number> } };
  const totals = data.totals as Record<string, number>;
  // The dashboard only rearranges ledger figures: the identities hold for whatever the shared database contains.
  expect(totals.netRevenueCents).toBe(totals.grossRevenueCents - totals.refundsCents - totals.feesCents + totals.divergencesCents);
  expect(totals.operatingProfitCents).toBe(totals.netRevenueCents - totals.cogsCents - totals.lossesCostCents - totals.operatingExpensesCents);
  expect(Object.values(data.byChannel).reduce((sum, value) => sum + value, 0)).toBe(totals.grossRevenueCents);
  expect((await page.request.get(`${portalUrl}/api/v1/admin/finance/indicators?from=${today()}&to=${from}`)).status()).toBe(from === today() ? 200 : 422);

  await page.goto(`${portalUrl}/admin/financeiro/indicadores`);
  await expect(page.getByRole("main").getByRole("heading", { name: "Indicadores", level: 1 })).toBeVisible();
  const result = page.getByRole("region", { name: "Resultado do período" });
  await expect(result.getByText("Receita bruta")).toBeVisible();
  await expect(result.getByText("Lucro operacional estimado")).toBeVisible();
  await page.getByRole("button", { name: "Hoje" }).click();
  await expect(page.getByLabel("De", { exact: true })).toHaveValue(today());
  await expect(result.getByText("Receita líquida")).toBeVisible();
});
