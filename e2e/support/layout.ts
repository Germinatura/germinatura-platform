import { expect, type Locator, type Page } from "@playwright/test";

/** The viewports every layout check covers (phone, tablet, small laptop, laptops, desktop). */
export const layoutViewports = [
  { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1024, height: 768 },
  { width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 },
] as const;

/**
 * The page never scrolls sideways: neither the document nor the dashboard scroll container. Regions made to scroll
 * (tables in `.overflow-x-auto`) are allowed to be wider than the screen inside themselves.
 */
export async function expectNoHorizontalOverflow(page: Page, label: string) {
  const report = await page.evaluate(() => {
    const container = document.querySelector<HTMLElement>("[data-testid=dashboard-scroll-container]");
    const scrollRegion = (element: Element) => element.closest(".overflow-x-auto, .overflow-x-scroll, [data-horizontal-scroll]");
    const offenders = [...document.querySelectorAll("body *")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0 || scrollRegion(element)) return false;
        const style = getComputedStyle(element);
        if (style.position === "fixed" || style.visibility === "hidden") return false;
        return box.right > window.innerWidth + 1;
      })
      .slice(0, 5)
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 80)}`);
    return {
      documentWidth: document.documentElement.scrollWidth, viewport: window.innerWidth,
      containerOverflow: container ? container.scrollWidth - container.clientWidth : 0, offenders,
    };
  });
  expect(report.documentWidth, `${label}: ${report.offenders.join(" | ")}`).toBeLessThanOrEqual(report.viewport);
  expect(report.containerOverflow, `${label}: ${report.offenders.join(" | ")}`).toBeLessThanOrEqual(1);
}

/** Two boxes do not intersect (a one pixel touch is allowed). */
export async function expectApart(first: Locator, second: Locator, label: string) {
  const [a, b] = [await first.boundingBox(), await second.boundingBox()];
  expect(a && b, `${label}: both elements are visible`).toBeTruthy();
  if (!a || !b) return;
  const overlap = a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
  expect(overlap, `${label}: ${JSON.stringify({ a, b })}`).toBe(false);
}

/** Every element stays inside its container horizontally. */
export async function expectInside(container: Locator, elements: Locator, label: string) {
  const outer = await container.boundingBox();
  expect(outer, `${label}: container is visible`).toBeTruthy();
  for (const box of await elements.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON() as DOMRect))) {
    expect(box.left, label).toBeGreaterThanOrEqual((outer?.x ?? 0) - 1);
    expect(box.right, label).toBeLessThanOrEqual((outer?.x ?? 0) + (outer?.width ?? 0) + 1);
  }
}

/** The text of an input with a leading icon starts after the icon: the icon never covers text or placeholder. */
export async function expectIconClearOfText(group: Locator, label: string) {
  const geometry = await group.evaluate((element) => {
    const icon = element.querySelector(".g-input-group__icon svg")?.getBoundingClientRect();
    const input = element.querySelector("input");
    if (!icon || !input) return null;
    const box = input.getBoundingClientRect();
    return { iconRight: icon.right, textStart: box.left + parseFloat(getComputedStyle(input).paddingLeft) };
  });
  expect(geometry, `${label}: icon and input found`).toBeTruthy();
  expect(geometry!.textStart, label).toBeGreaterThanOrEqual(geometry!.iconRight);
}
