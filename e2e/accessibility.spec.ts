import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

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

async function signIn(page: Page, base: string, identifier: string, password: string) {
  const headers = base === pdvUrl ? { Origin: pdvUrl, "Sec-Fetch-Site": "same-origin" } : { Origin: portalUrl };
  expect((await page.request.post(`${base}/api/auth/login`, { headers, data: { identifier, password } })).status()).toBe(200);
}

test("as telas principais de cada papel não têm violações sérias de acessibilidade", async ({ browser }) => {
  test.setTimeout(600_000);
  const findings: string[] = [];

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
