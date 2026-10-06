import { describe, expect, it } from "vitest";
import { parseReais } from "./money-input";

describe("parseReais", () => {
  it("reads amounts typed in reais into exact cents", () => {
    expect(parseReais("19.277,65")).toBe(1_927_765);
    expect(parseReais("19277,65")).toBe(1_927_765);
    expect(parseReais("0,39")).toBe(39);
    expect(parseReais("111,78")).toBe(11_178);
    expect(parseReais("111.78")).toBe(11_178);
    expect(parseReais("111")).toBe(11_100);
    expect(parseReais("1.000")).toBe(100_000);
    expect(parseReais(" 0,10 ")).toBe(10);
  });

  it("refuses negative, over-precise and malformed amounts", () => {
    for (const value of ["", "-1,00", "1,234", "abc", "1,2,3", "12.34.56,7"]) expect(parseReais(value)).toBeNull();
  });
});
