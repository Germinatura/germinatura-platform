import { expect, test } from "@playwright/test";
import { kinder, sellerA, session } from "../support";

// H2a: on phones the sale review follows the scroll in a fixed bar; desktops keep the sticky summary.
test("H2a: barra de revisão fixa em 320, 360 e 390 px e resumo lateral no desktop", async ({ browser }) => {
  const seller = await session(browser, "pdv", sellerA.username);
  const page = await seller.context.newPage();
  const add = page.getByRole("button", { name: `Adicionar uma unidade de ${kinder.name}` });
  const bar = page.getByRole("region", { name: "Venda em andamento" });
  try {
    for (const viewport of [{ width: 320, height: 640 }, { width: 360, height: 740 }, { width: 390, height: 844 }]) {
      const label = `${viewport.width}×${viewport.height}`;
      await page.setViewportSize(viewport);
      await page.goto("/");
      await expect(add, label).toBeVisible({ timeout: 90_000 });
      await expect(bar, label).toHaveCount(0);
      await add.click();
      await expect(bar, label).toContainText("1 item");
      await expect(bar, label).toContainText("25,90");
      for (const position of ["top", "bottom"] as const) {
        await page.evaluate((where) => window.scrollTo(0, where === "top" ? 0 : document.body.scrollHeight), position);
        const box = await bar.boundingBox();
        expect(Math.round((box?.y ?? 0) + (box?.height ?? 0)), `${label} ${position}`).toBe(viewport.height);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${label}: sem rolagem horizontal`).toBeLessThanOrEqual(viewport.width);
      await page.getByRole("button", { name: `Remover uma unidade de ${kinder.name}` }).click();
      await expect(bar, label).toHaveCount(0);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await add.click();
    await expect(bar).toBeHidden();
    await expect(page.getByRole("complementary").getByRole("button", { name: "Revisar venda" })).toBeVisible();
  } finally {
    await seller.context.close();
  }
});
