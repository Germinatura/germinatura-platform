import { expect, test, type Page } from "@playwright/test";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
// Smallest valid PNG (1×1, transparent).
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

async function signIn(page: Page, identifier: string, password: string) {
  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl }, data: { identifier, password } })).status()).toBe(200);
}

test("comunicação publica um evento com capa, o consumidor o encontra e o cancelamento fica no histórico", async ({ browser }) => {
  test.slow();
  const tag = Date.now().toString(36);
  const title = `Festa da formatura ${tag}`;
  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, "admin.teste", "Admin123!");
  // The dev server compiles each route on its first request: warm them before the journey.
  for (const request of [admin.request.get(`${portalUrl}/api/v1/admin/events`), admin.request.get(`${portalUrl}/api/v1/events`)]) {
    expect((await request).status()).toBe(200);
  }
  await admin.goto(`${portalUrl}/admin/comunicacao/eventos`);
  const form = admin.getByRole("form", { name: "Evento" });
  await expect(admin.getByRole("list", { name: "Eventos" }).or(admin.getByText("Nenhum evento cadastrado."))).toBeVisible({ timeout: 90_000 });
  await form.getByLabel("Título").fill(title);
  await form.getByLabel("Descrição").fill("Noite com DJ, comidas e bebidas da comissão.");
  const start = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(Date.now() + 7 * 86_400_000));
  await form.getByLabel("Início").fill(`${start}T19:00`);
  await form.getByLabel("Fim (opcional)").fill(`${start}T23:30`);
  await form.getByLabel("Local (opcional)").fill("Ginásio da escola");
  await form.getByLabel("Chamada para ação (opcional)").fill("Ver catálogo");
  await form.getByLabel("Link da chamada").fill("/catalogo");
  await form.getByRole("button", { name: "Criar rascunho" }).click();
  await expect(admin.getByText("Rascunho criado.")).toBeVisible();

  const item = admin.getByRole("listitem", { name: title });
  await expect(item.getByText("Rascunho")).toBeVisible();
  await item.getByRole("button", { name: "Capa" }).click();
  await item.getByLabel("Imagem (JPG, PNG ou WebP, até 5 MB)").setInputFiles({ name: "capa.png", mimeType: "image/png", buffer: png });
  await item.getByLabel("Descrição da imagem").fill("Pista de dança iluminada");
  await item.getByRole("button", { name: "Enviar capa" }).click();
  await expect(admin.getByText("Capa atualizada.")).toBeVisible({ timeout: 60_000 });
  await item.getByRole("button", { name: "Publicar" }).click();
  await expect(admin.getByText("Evento publicado.")).toBeVisible({ timeout: 60_000 });

  // A text file with an image name is refused by content.
  const id = await admin.evaluate(async (eventTitle) => {
    const response = await fetch("/api/v1/admin/events", { cache: "no-store" });
    const body = await response.json() as { data: { id: string; title: string }[] };
    return body.data.find((event) => event.title === eventTitle)?.id ?? "";
  }, title);
  const fake = await admin.request.post(`${portalUrl}/api/v1/admin/events/${id}/cover?alt=texto`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-event-fake-cover-${tag}`, "Content-Type": "image/png" }, data: Buffer.from("não sou imagem"),
  });
  expect(fake.status()).toBe(422);

  const consumer = await (await browser.newContext()).newPage();
  await signIn(consumer, "consumidor.teste", "Consumidor123!");
  await consumer.goto(`${portalUrl}/eventos`);
  const card = consumer.getByRole("listitem", { name: title });
  await expect(card).toBeVisible({ timeout: 90_000 });
  await expect(card.getByText("Ginásio da escola")).toBeVisible();
  await card.getByRole("link", { name: title }).click();
  // First visit compiles the event page on the dev server.
  await expect(consumer).toHaveURL(new RegExp(`/eventos/${id}$`), { timeout: 90_000 });
  await expect(consumer.getByRole("img", { name: "Pista de dança iluminada" })).toBeVisible({ timeout: 60_000 });
  await expect(consumer.getByRole("link", { name: "Ver catálogo" })).toHaveAttribute("href", "/catalogo");
  await expect(consumer.getByRole("button", { name: "Copiar convite" })).toBeVisible();
  // Consumers cannot manage events.
  const blocked = await consumer.request.post(`${portalUrl}/api/v1/admin/events/${id}/transition`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-event-consumer-${tag}` }, data: { action: "CANCELAR", reason: "Tentativa do consumidor" },
  });
  expect(blocked.status()).toBe(403);

  await item.getByRole("button", { name: "Cancelar evento" }).click();
  await item.getByLabel("Motivo do cancelamento").fill("Ginásio indisponível na data");
  await item.getByRole("button", { name: "Confirmar cancelamento" }).click();
  await expect(admin.getByText("Evento cancelado.")).toBeVisible();
  await expect(item.getByText("Cancelado")).toBeVisible();

  await consumer.reload();
  await expect(consumer.getByText("Cancelado: Ginásio indisponível na data")).toBeVisible({ timeout: 60_000 });
  await admin.context().close();
  await consumer.context().close();
});
