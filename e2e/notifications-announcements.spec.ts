// Runs after foundation.spec.ts on purpose: it drains the outbox, which gives the admin new notices.
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const headers = { Origin: portalUrl };

// Runs the outbox worker once with the local service role, as apps/jobs does in staging.
async function processOutbox() {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^SERVICE_ROLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error("Supabase local indisponível para o worker E2E");
  const auth = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const worker = `e2e-worker-${Date.now().toString(36)}`;
  for (let round = 0; round < 50; round += 1) {
    const claimed = await fetch(`${url}/rest/v1/rpc/worker_claim_outbox_events`, { method: "POST", headers: auth,
      body: JSON.stringify({ p_worker_id: worker, p_batch_size: 100, p_lease_seconds: 300 }) });
    const events = await claimed.json() as Array<{ id: string }>;
    if (!Array.isArray(events) || events.length === 0) return;
    for (const event of events) {
      await fetch(`${url}/rest/v1/rpc/worker_process_outbox_event`, { method: "POST", headers: auth,
        body: JSON.stringify({ p_event_id: event.id, p_worker_id: worker }) });
    }
  }
}

test("a comunicação envia um aviso para um e-mail e a pessoa o recebe na central", async ({ page, browser }) => {
  test.slow();
  const tag = Date.now().toString(36);
  const title = `Aviso de teste ${tag}`;
  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  await page.goto(`${portalUrl}/admin/comunicacao/avisos`);
  const form = page.getByRole("form", { name: "Novo aviso" });
  await form.getByLabel("Título").fill(title);
  await form.getByLabel("Mensagem").fill("A retirada das camisetas começa amanhã às 12h.");
  await form.getByLabel("E-mails específicos (opcional)").fill("consumidor.teste@institutojef.org.br");
  await form.getByRole("button", { name: "Enviar aviso" }).click();
  await form.getByRole("button", { name: "Confirmar envio" }).click();
  await expect(page.getByText("Aviso enviado para 1 pessoa(s).")).toBeVisible();
  await expect(page.getByRole("listitem", { name: `Aviso ${title}` })).toBeVisible();

  const unknown = await page.request.post(`${portalUrl}/api/v1/admin/announcements`, { headers: { ...headers, "Idempotency-Key": `e2e-ann-unknown-${tag}` },
    data: { title: "Aviso", body: "Mensagem", all: false, roles: [], emails: ["ninguem@institutojef.org.br"] } });
  expect(unknown.status()).toBe(422);

  const consumer = await browser.newContext({ baseURL: portalUrl });
  const consumerPage = await consumer.newPage();
  expect((await consumerPage.request.post("/api/auth/login", { headers, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
  // Announcements are an optional category; make sure this consumer keeps it on before delivery.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if ((await consumerPage.request.put("/api/v1/notifications/preferences", { headers, data: { category: "COMUNICADOS", enabled: true } })).status() === 200) break;
    await consumerPage.waitForTimeout(500);
  }
  await processOutbox();
  const denied = await consumerPage.request.get("/api/v1/admin/announcements");
  expect(denied.status()).toBe(403);
  await consumerPage.goto("/notificacoes");
  await expect(consumerPage.getByText(title)).toBeVisible();
  await consumer.close();
});
