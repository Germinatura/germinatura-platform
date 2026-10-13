import { describe, expect, it } from "vitest";
import { dayLabel, periodLabel } from "./filter-chips";

describe("filter chip labels", () => {
  it("writes a typed day as a Brazilian date without shifting it by a time zone", () => {
    expect(dayLabel("2026-10-13")).toBe("13/10/2026");
    expect(dayLabel("2026-01-01")).toBe("01/01/2026");
    expect(dayLabel("")).toBe("");
  });

  it("describes closed and open periods", () => {
    expect(periodLabel("2026-10-07", "2026-10-13")).toBe("Período: 07/10/2026 a 13/10/2026");
    expect(periodLabel("2026-10-07", "", "Criadas")).toBe("Criadas: desde 07/10/2026");
    expect(periodLabel("", "2026-10-13", "Criadas")).toBe("Criadas: até 13/10/2026");
  });
});
