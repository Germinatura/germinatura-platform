import { expect, test } from "@playwright/test";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
function shift(day: string, days: number) {
  const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
}

test("a comissão configura a meta e a turma vê só o percentual quando os valores estão ocultos", async ({ page, browser }) => {
  test.slow();
  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl }, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  await page.goto(`${portalUrl}/admin/configuracoes`);
  const form = page.getByRole("form", { name: "Meta de arrecadação" });
  await expect(form.getByRole("button", { name: "Salvar meta" })).toBeEnabled();
  await form.getByLabel("Meta (R$)").fill("50.000,00");
  await form.getByLabel("Início da contagem").fill(shift(today(), -30));
  await form.getByLabel("Data-alvo").fill(shift(today(), 180));
  await form.getByLabel("Mostrar o progresso na página inicial da turma").check();
  await form.getByLabel(/Mostrar valores em reais/).uncheck();
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/v1/admin/settings/fundraising-goal") && response.request().method() === "PUT");
  await form.getByRole("button", { name: "Salvar meta" }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByText("Meta salva.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Progresso atual" }).getByText(/de R\$\s*50\.000,00/)).toBeVisible();

  try {
    const consumer = await browser.newContext({ baseURL: portalUrl });
    const home = await consumer.newPage();
    expect((await home.request.post("/api/auth/login", { headers: { Origin: portalUrl }, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
    await home.goto("/inicio");
    const progress = home.getByRole("progressbar", { name: "Meta da formatura" });
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute("aria-valuetext", /% da meta$/);
    await expect(home.getByText("50.000,00")).toHaveCount(0);
    // Finance-only settings stay closed to the class.
    expect((await consumer.request.get("/api/v1/admin/settings/fundraising-goal")).status()).toBe(403);
    await consumer.close();
  } finally {
    await form.getByLabel("Mostrar o progresso na página inicial da turma").uncheck();
    const unpublished = page.waitForResponse((response) => response.url().endsWith("/api/v1/admin/settings/fundraising-goal") && response.request().method() === "PUT");
    await form.getByRole("button", { name: "Salvar meta" }).click();
    expect((await unpublished).status()).toBe(200);
  }
});
