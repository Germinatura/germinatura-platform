import { describe, expect, it } from "vitest";
import { centsToCsvAmount, toCsv } from "./csv";

const bom = String.fromCharCode(0xfeff);

describe("CSV export", () => {
  it("writes a BOM, a header and CRLF lines separated by semicolons", () => {
    expect(toCsv(["data", "valor"], [["2026-09-28", "25,90"]])).toBe(`${bom}data;valor\r\n2026-09-28;25,90\r\n`);
  });

  it("quotes separators, quotes and line breaks", () => {
    expect(toCsv(["texto"], [["a;b"], ['diz "oi"'], ["linha\nnova"], [null]])).toBe(`${bom}texto\r\n"a;b"\r\n"diz ""oi"""\r\n"linha\nnova"\r\n\r\n`);
  });

  it("neutralizes spreadsheet formulas in text but keeps numbers and amounts", () => {
    expect(toCsv(["texto", "numero", "valor"], [["=HYPERLINK(1)", -2590, { cents: -2590 }]]))
      .toBe(`${bom}texto;numero;valor\r\n'=HYPERLINK(1);-2590;-25,90\r\n`);
  });

  it("formats cents with a decimal comma", () => {
    expect(centsToCsvAmount(2590)).toBe("25,90");
    expect(centsToCsvAmount(-5)).toBe("-0,05");
    expect(centsToCsvAmount(0)).toBe("0,00");
    expect(() => centsToCsvAmount(1.5)).toThrow(RangeError);
  });
});
