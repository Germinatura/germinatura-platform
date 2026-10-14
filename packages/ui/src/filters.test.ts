import { describe, expect, it } from "vitest";
import { filterTriggerLabel } from "./filters";

describe("filter shell", () => {
  it("names the inline toggle by what it does and counts the filters in effect otherwise", () => {
    expect(filterTriggerLabel({ inline: true, expanded: true, count: 3 })).toBe("Recolher filtros");
    expect(filterTriggerLabel({ inline: true, expanded: false, count: 3 })).toBe("Filtros (3)");
    expect(filterTriggerLabel({ inline: true, expanded: false, count: 0 })).toBe("Filtros");
  });

  it("always offers the sheet with the count on narrow screens, even when the inline panel would be open", () => {
    expect(filterTriggerLabel({ inline: false, expanded: true, count: 2 })).toBe("Filtros (2)");
    expect(filterTriggerLabel({ inline: false, expanded: true, count: 0 })).toBe("Filtros");
    // Before the browser reports its width, the label never claims to collapse anything.
    expect(filterTriggerLabel({ inline: null, expanded: true, count: 1 })).toBe("Filtros (1)");
  });
});
