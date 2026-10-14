import { describe, expect, it } from "vitest";
import { todayInSaoPaulo } from "./sao-paulo-date";

describe("today in São Paulo", () => {
  it("keeps the São Paulo day near midnight, never the UTC one", () => {
    // 23:30 in São Paulo (UTC-3) is already 02:30 of the next day in UTC.
    expect(todayInSaoPaulo(new Date("2026-10-14T02:30:00Z"))).toBe("2026-10-13");
    expect(todayInSaoPaulo(new Date("2026-10-14T02:59:59Z"))).toBe("2026-10-13");
    expect(todayInSaoPaulo(new Date("2026-10-14T03:00:00Z"))).toBe("2026-10-14");
    // Early morning in São Paulo is still the same UTC day.
    expect(todayInSaoPaulo(new Date("2026-10-13T03:05:00Z"))).toBe("2026-10-13");
  });

  it("uses the YYYY-MM-DD format of a date input", () => {
    expect(todayInSaoPaulo(new Date("2026-01-01T12:00:00Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
