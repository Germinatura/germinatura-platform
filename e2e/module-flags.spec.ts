import { expect, test, type APIRequestContext } from "@playwright/test";

const origin = "http://127.0.0.1:3000";
const headers = { Origin: origin, "Sec-Fetch-Site": "same-origin" };

async function setFlag(request: APIRequestContext, key: string, enabled: boolean) {
  const response = await request.patch(`/api/v1/admin/feature-flags/${key}`, { headers, data: { enabled, reason: enabled ? "Fim do teste de módulo" : "Teste de módulo desligado" } });
  expect(response.status()).toBe(200);
}

test("switching off events and procurement hides them and keeps the history readable", async ({ page, browser }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  expect((await page.request.post("/api/auth/login", { headers, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  await page.goto("/admin/configuracoes", { timeout: 60_000 });
  const flags = page.getByRole("list", { name: "Chaves funcionais" });
  await expect(flags.getByRole("listitem", { name: "Chave procurement" }).getByText(/Pedidos abertos podem ser cancelados/)).toBeVisible();
  await expect(flags.getByRole("listitem", { name: "Chave cash_payment" }).getByRole("link", { name: "Conferir turnos" })).toBeVisible();

  const consumer = await browser.newContext({ baseURL: origin });
  try {
    await setFlag(page.request, "events", false);
    await setFlag(page.request, "procurement", false);

    await page.goto("/admin/compras", { timeout: 60_000 });
    await expect(page.getByText("Módulo desligado em Configurações")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Fornecedores", exact: true })).toBeVisible();
    const sidebar = page.locator("aside");
    await expect(sidebar.getByRole("link", { name: "Contas a pagar" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Compras e fornecedores" })).toHaveCount(0);
    await expect(sidebar.getByRole("link", { name: "Gestão de eventos" })).toHaveCount(0);

    await page.goto("/admin/comunicacao/eventos", { timeout: 60_000 });
    await expect(page.getByText("Módulo desligado em Configurações")).toBeVisible();

    const consumerPage = await consumer.newPage();
    expect((await consumerPage.request.post("/api/auth/login", { headers, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
    const events = await consumerPage.request.get("/api/v1/events");
    expect(events.status()).toBe(200);
    expect((await events.json() as { data: unknown[] }).data).toEqual([]);
    const showcase = await consumerPage.request.get("/api/v1/showcase");
    expect((await showcase.json() as { data: { events: unknown[] } }).data.events).toEqual([]);
    await consumerPage.goto("/eventos", { timeout: 60_000 });
    await expect(consumerPage.getByText("Eventos e campanhas não estão disponíveis no momento.")).toBeVisible();
    await expect(consumerPage.locator("aside").getByRole("link", { name: "Eventos e campanhas" })).toHaveCount(0);
  } finally {
    await setFlag(page.request, "events", true);
    await setFlag(page.request, "procurement", true);
    await consumer.close();
  }
});
