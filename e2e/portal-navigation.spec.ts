import { expect, test, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:3000";
const headers = { Origin: origin, "Sec-Fetch-Site": "same-origin" };

async function login(page: Page, identifier: string, password: string) {
  expect((await page.request.post("/api/auth/login", { headers, data: { identifier, password } })).status()).toBe(200);
}

test("Admin collapses sidebar sections, keeps the choice and never loses the active route", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, "admin.teste", "Admin123!");
  await page.goto("/admin/estoque", { timeout: 60_000 });
  const sidebar = page.locator("aside");
  const finance = sidebar.getByRole("button", { name: "Financeiro" });
  const catalog = sidebar.getByRole("button", { name: "Catálogo e estoque" });
  await expect(finance).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar.getByRole("link", { name: "Turnos de caixa" })).toBeVisible();

  // Keyboard: Enter toggles, arrows move between section headers.
  await finance.focus();
  await page.keyboard.press("Enter");
  await expect(finance).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar.getByRole("link", { name: "Turnos de caixa" })).toHaveCount(0);
  await page.keyboard.press("ArrowUp");
  await expect(catalog).toBeFocused();

  // The active section collapsed still shows the current page.
  await page.keyboard.press("Space");
  await expect(catalog).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar.getByRole("link", { name: "Estoque", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Compras e fornecedores" })).toHaveCount(0);

  // The preference survives a reload.
  await page.reload();
  await expect(finance).toHaveAttribute("aria-expanded", "false");

  // Arriving at a route in a collapsed section opens it.
  await page.goto("/admin/financeiro/turnos", { timeout: 60_000 });
  await expect(finance).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar.getByRole("link", { name: "Turnos de caixa" })).toHaveAttribute("aria-current", "page");

  // The fully collapsed sidebar still lists every entry as an icon.
  await sidebar.getByRole("button", { name: "Recolher sidebar" }).click();
  await expect(sidebar.getByRole("link", { name: "Compras e fornecedores" })).toBeVisible();
});

test("Command palette finds only reachable screens and navigates by keyboard", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, "admin.teste", "Admin123!");
  await page.goto("/", { timeout: 60_000 });
  await expect(page.locator("aside").getByRole("button", { name: /Pesquisar no menu/ })).toBeVisible();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Pesquisar no menu" });
  await expect(dialog).toBeVisible();
  const input = dialog.getByRole("combobox", { name: "Pesquisar telas" });
  await expect(input).toBeFocused();
  await input.fill("fornecedor");
  await expect(dialog.getByRole("option", { name: /Compras e fornecedores/ })).toBeVisible();
  await expect(dialog.getByRole("option", { name: /Contas a pagar/ })).toBeVisible();
  await input.fill("turno");
  await expect(dialog.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/admin\/financeiro\/turnos$/);
  await expect(dialog).toHaveCount(0);

  await page.keyboard.press("Control+k");
  await input.fill("xyz-sem-tela");
  await expect(dialog.getByText("Nenhuma tela encontrada")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("Consumer search and mobile drawer only offer consumer screens", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "consumidor.teste", "Consumidor123!");
  await page.goto("/inicio", { timeout: 60_000 });
  await page.getByRole("button", { name: "Abrir navegação" }).click();
  const drawer = page.getByTestId("mobile-sidebar");
  await expect(drawer.getByRole("button", { name: "Explorar" })).toHaveAttribute("aria-expanded", "true");
  await drawer.getByRole("button", { name: /Pesquisar no menu/ }).click();
  const dialog = page.getByRole("dialog", { name: "Pesquisar no menu" });
  const input = dialog.getByRole("combobox", { name: "Pesquisar telas" });
  await input.fill("auditoria");
  await expect(dialog.getByText("Nenhuma tela encontrada")).toBeVisible();
  await input.fill("reserva");
  await dialog.getByRole("option", { name: /Minhas reservas/ }).click();
  await expect(page).toHaveURL(/\/reservas$/);
});
