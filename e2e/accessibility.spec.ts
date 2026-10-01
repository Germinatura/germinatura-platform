import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";

// Release readiness: WCAG 2.1 A/AA checks on the main screen of each role. Serious and critical findings fail.
async function audit(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return result.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => `${url} · ${violation.id} (${violation.impact}): ${violation.nodes.slice(0, 3).map((node) => node.target.join(" ")).join(" | ")}`);
}

// Pages with data render more markup than their empty states: make sure there is something to audit.
async function adminRpc(name: string, body: Record<string, unknown>) {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key) throw new Error("Supabase local indisponível para a auditoria de acessibilidade");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`${name}: ${String(result.message ?? response.status)}`);
  return result;
}

async function signIn(page: Page, base: string, identifier: string, password: string) {
  const headers = base === pdvUrl ? { Origin: pdvUrl, "Sec-Fetch-Site": "same-origin" } : { Origin: portalUrl };
  expect((await page.request.post(`${base}/api/auth/login`, { headers, data: { identifier, password } })).status()).toBe(200);
}

test("as telas principais de cada papel não têm violações sérias de acessibilidade", async ({ browser }) => {
  // Fourteen pages compiled on first visit by the dev server.
  test.setTimeout(900_000);
  const findings: string[] = [];
  const tag = Date.now().toString(36);
  const raffle = await adminRpc("create_raffle_campaign", {
    p_name: `Rifa acessível ${tag}`, p_product_id: "33f00000-0000-4000-8000-000000000001", p_location_id: "50000000-0000-4000-8000-000000000001",
    p_number_count: 10, p_starts_at: new Date(Date.now() - 60_000).toISOString(), p_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
    p_idempotency_key: `e2e-a11y-raffle-${tag}`, p_correlation_id: crypto.randomUUID(),
  });
  await adminRpc("transition_raffle_campaign", { p_campaign_id: raffle.campaign_id, p_action: "PUBLISH",
    p_idempotency_key: `e2e-a11y-publish-${tag}`, p_correlation_id: crypto.randomUUID() });

  const visitor = await (await browser.newContext()).newPage();
  findings.push(...await audit(visitor, `${portalUrl}/login`));
  await visitor.context().close();

  const consumer = await (await browser.newContext()).newPage();
  await signIn(consumer, portalUrl, "consumidor.teste", "Consumidor123!");
  for (const path of ["/inicio", "/catalogo", "/reservas", "/rifas", "/perfil"]) findings.push(...await audit(consumer, `${portalUrl}${path}`));
  await consumer.context().close();

  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, portalUrl, "admin.teste", "Admin123!");
  for (const path of ["/", "/admin/financeiro/indicadores", "/admin/financeiro/vendas", "/admin/auditoria", "/admin/configuracoes", "/admin/usuarios", "/admin/rifas"]) {
    findings.push(...await audit(admin, `${portalUrl}${path}`));
  }
  await admin.context().close();

  const seller = await (await browser.newContext()).newPage();
  await signIn(seller, pdvUrl, "vendedor.teste", "Vendedor123!");
  findings.push(...await audit(seller, `${pdvUrl}/`));
  await seller.context().close();

  expect(findings, findings.join("\n")).toEqual([]);
});
