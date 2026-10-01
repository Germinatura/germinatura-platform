import { expect, test, type Page } from "@playwright/test";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";

async function signIn(page: Page, identifier: string, password: string) {
  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl }, data: { identifier, password } })).status()).toBe(200);
}

test("o Início mostra o destaque da comissão, os próximos eventos e o acesso rápido", async ({ browser }) => {
  test.slow();
  const tag = Date.now().toString(36);
  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, "admin.teste", "Admin123!");
  // Starts soon, so it comes before events left by earlier runs on a shared database.
  const start = new Date(Date.now() + 3_600_000).toISOString();
  const created = await admin.request.post(`${portalUrl}/api/v1/admin/events`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-showcase-event-${tag}` },
    data: { expectedRevision: null, kind: "EVENTO", title: `Festa da vitrine ${tag}`, description: "Noite de festa da turma.", startsAt: start,
      endsAt: null, location: "Quadra", externalUrl: null, ctaLabel: null, ctaUrl: null, productIds: [], promotionIds: [], sellerIds: [] },
  });
  expect(created.status()).toBe(201);
  const eventId = (await created.json() as { data: { id: string } }).data.id;
  expect((await admin.request.post(`${portalUrl}/api/v1/admin/events/${eventId}/transition`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-showcase-publish-${tag}` }, data: { action: "PUBLICAR" },
  })).status()).toBe(200);

  await admin.goto(`${portalUrl}/admin/comunicacao/eventos`);
  const form = admin.getByRole("form", { name: "Destaque do Início" });
  await expect(form.getByLabel("Título")).toBeEnabled({ timeout: 90_000 });
  await form.getByLabel("Título").fill(`Ingressos da festa ${tag}`);
  await form.getByLabel("Mensagem (opcional)").fill("Garanta o seu com um vendedor.");
  await form.getByLabel("Chamada para ação (opcional)").fill("Ver eventos");
  await form.getByLabel("Link da chamada").fill("/eventos");
  await form.getByLabel("Mostrar no Início").check();
  await form.getByRole("button", { name: "Salvar destaque" }).click();
  await expect(admin.getByText("Destaque publicado no Início.")).toBeVisible({ timeout: 60_000 });

  const consumer = await (await browser.newContext()).newPage();
  await signIn(consumer, "consumidor.teste", "Consumidor123!");
  await consumer.goto(`${portalUrl}/inicio`);
  const highlight = consumer.getByLabel("Destaque");
  await expect(highlight.getByText(`Ingressos da festa ${tag}`)).toBeVisible({ timeout: 90_000 });
  await expect(highlight.getByRole("link", { name: "Ver eventos" })).toHaveAttribute("href", "/eventos");
  await expect(consumer.getByRole("region", { name: "Próximos eventos" }).getByRole("link", { name: `Festa da vitrine ${tag}` })).toBeVisible();
  const quick = consumer.getByRole("navigation", { name: "Acesso rápido" });
  await expect(quick.getByRole("link", { name: "Minhas reservas" })).toBeVisible();
  await expect(quick.getByRole("link", { name: "Meus bilhetes" })).toBeVisible();

  // Turning the highlight off removes it from the Início page.
  expect((await admin.request.put(`${portalUrl}/api/v1/admin/showcase/highlight`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-showcase-off-${tag}` },
    data: { title: `Ingressos da festa ${tag}`, message: null, ctaLabel: null, ctaUrl: null, active: false, visibleUntil: null },
  })).status()).toBe(200);
  await consumer.reload();
  await expect(consumer.getByRole("region", { name: "Próximos eventos" })).toBeVisible({ timeout: 60_000 });
  await expect(consumer.getByLabel("Destaque")).toHaveCount(0);
  await admin.context().close();
  await consumer.context().close();
});
