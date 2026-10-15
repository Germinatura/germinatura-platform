import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";
const pdvHeaders = { Origin: pdvUrl, "Sec-Fetch-Site": "same-origin" };
const portalHeaders = { Origin: portalUrl, "Sec-Fetch-Site": "same-origin" };
const sellerLocationId = "50000000-0000-4000-8000-000000000002";
const itemA = "33f00000-0000-4000-8000-000000000001";

async function ensureSellerStock() {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key) throw new Error("Supabase local indisponível para preparar o estoque E2E");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const headers = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const balances = await fetch(`${url}/rest/v1/inventory_balances?select=available_quantity&location_id=eq.${sellerLocationId}&product_id=eq.${itemA}`, { headers });
  const current = ((await balances.json()) as Array<{ available_quantity: number }>)[0]?.available_quantity ?? 0;
  if (current >= 2) return;
  const response = await fetch(`${url}/rest/v1/rpc/adjust_stock`, { method: "POST", headers, body: JSON.stringify({
    p_location_id: sellerLocationId, p_product_id: itemA, p_quantity_delta: 2 - current,
    p_reason: "Preparar maquininha preferida E2E", p_idempotency_key: `e2e-terminal-pref-stock:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() }) });
  if (!response.ok) throw new Error("Não foi possível preparar o estoque do vendedor");
}

test("financeiro diz com quem está cada maquininha; o PDV pré-seleciona a do vendedor e ainda permite trocar", async ({ page, browser }) => {
  test.slow();
  await ensureSellerStock();
  const tag = Date.now().toString(36).toUpperCase();
  const romeu = `ROMEU-${tag}`;
  const julieta = `JULIETA-${tag}`;
  const finance = await browser.newContext({ baseURL: portalUrl });
  const financePage = await finance.newPage();
  expect((await financePage.request.post("/api/auth/login", { headers: portalHeaders, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  const create = async (code: string, label: string) => {
    const response = await financePage.request.post("/api/v1/admin/finance/terminals", {
      headers: { ...portalHeaders, "Idempotency-Key": `e2e-terminal-${code}` }, data: { code, label, active: true } });
    expect(response.status()).toBe(201);
    return (await response.json() as { data: { id: string } }).data.id;
  };
  const romeuId = await create(romeu, "Romeu");
  const julietaId = await create(julieta, "Julieta");

  try {
    // Finance: Romeu goes to the seller, with a reason; the list says with whom it is.
    await financePage.goto("/admin/financeiro/maquininhas");
    const row = financePage.getByRole("listitem", { name: `Maquininha ${romeu}` });
    await expect(row.getByText("Ninguém")).toBeVisible();
    await row.getByRole("button", { name: "Com quem está" }).click();
    const form = row.getByRole("form", { name: `Responsável por ${romeu}` });
    await form.getByLabel("Responsável").selectOption({ label: "Vendedor Local" });
    await form.getByLabel("Motivo").fill("Entregue no turno da manhã");
    await form.getByRole("button", { name: "Salvar responsável" }).click();
    await expect(row.getByText("Vendedor Local")).toBeVisible();

    // Seller: Romeu is preselected and labelled; Julieta can still be chosen and used.
    expect((await page.request.post(`${pdvUrl}/api/auth/login`, { headers: pdvHeaders, data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
    const choice = await page.request.get(`${pdvUrl}/api/v1/pdv/terminals`, { headers: pdvHeaders });
    expect((await choice.json() as { preference: { terminalId: string; source: string } }).preference).toEqual({ terminalId: romeuId, source: "ASSIGNED" });
    await page.goto(`${pdvUrl}/`);
    await page.getByRole("button", { name: "Adicionar uma unidade de Item público A" }).click();
    await page.getByRole("complementary").getByRole("button", { name: "Revisar venda" }).click();
    await page.getByRole("button", { name: /^Cobrar/ }).click();
    await expect(page.getByRole("heading", { name: "Confirmar pagamento" })).toBeVisible();
    const picker = page.getByLabel("Maquininha usada");
    await expect(picker).toHaveValue(romeuId);
    await expect(picker.locator("option:checked")).toHaveText(`${romeu} · Romeu (com Vendedor Local)`);
    await picker.selectOption(julietaId);
    await page.getByRole("button", { name: "Débito" }).click();
    await page.getByLabel(/^Referência/).fill(`NSU-PREF-${tag}`);
    const confirmation = page.waitForResponse((response) => response.url().endsWith("/payments/manual-confirmation"));
    await page.getByRole("button", { name: "Confirmar recebimento manualmente" }).click();
    expect((await confirmation).status()).toBe(200);
    await expect(page.getByText(`Débito · ${julieta}`)).toBeVisible();

    // Removing the assignment: the last terminal used (Julieta) becomes the preselection.
    const removal = await financePage.request.post(`/api/v1/admin/finance/terminals/${romeuId}/assignment`, {
      headers: { ...portalHeaders, "Idempotency-Key": `e2e-terminal-free-${tag}` }, data: { assigneeId: null, reason: "Devolvida ao caixa" } });
    expect(removal.status()).toBe(200);
    const after = await page.request.get(`${pdvUrl}/api/v1/pdv/terminals`, { headers: pdvHeaders });
    expect((await after.json() as { preference: { terminalId: string; source: string } }).preference).toEqual({ terminalId: julietaId, source: "LAST_USED" });
    // A seller cannot manage assignments.
    expect((await page.request.post(`${portalUrl}/api/v1/admin/finance/terminals/${romeuId}/assignment`, {
      headers: { ...portalHeaders, "Idempotency-Key": `e2e-terminal-seller-${tag}` }, data: { assigneeId: null, reason: "Tentativa indevida" } })).status()).toBe(403);
  } finally {
    // Leave no active terminal behind: other suites confirm Maquininha payments without one.
    for (const [id, code, label] of [[romeuId, romeu, "Romeu"], [julietaId, julieta, "Julieta"]]) {
      await financePage.request.patch(`/api/v1/admin/finance/terminals/${id}`, {
        headers: { ...portalHeaders, "Idempotency-Key": `e2e-terminal-off-${code}` }, data: { code, label, active: false } });
    }
    await finance.close();
  }
});
