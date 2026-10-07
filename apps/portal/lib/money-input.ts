/**
 * Reads an amount typed in reais into cents, without floating point: "19.277,65", "19277,65", "0,39", "111" and
 * "111.78" are accepted; negative amounts, more than two decimals and anything else are refused (null).
 */
export function parseReais(value: string): number | null {
  const compact = value.trim().replace(/\s/g, "");
  // A dot followed by exactly three digits is a thousands separator; a comma (or a last dot) is the decimal one.
  if (compact.includes(",")) {
    const [units, fraction, ...rest] = compact.split(",");
    if (rest.length > 0 || !/^(\d+|\d{1,3}(\.\d{3})+)$/.test(units) || !/^\d{1,2}$/.test(fraction)) return null;
    return toCents(units.replace(/\./g, ""), fraction);
  }
  const normalized = /^\d{1,3}(\.\d{3})+$/.test(compact) ? compact.replace(/\./g, "") : compact;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [units, fraction = ""] = normalized.split(".");
  return toCents(units, fraction);
}

function toCents(units: string, fraction: string) {
  if (units.length > 13) return null;
  return Number(units) * 100 + Number(fraction.padEnd(2, "0"));
}
