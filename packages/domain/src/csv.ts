/** Cell of a CSV export: text is escaped, numbers are written as given, `{ cents }` as a decimal-comma amount, null is empty. */
export type CsvCell = string | number | { cents: number } | null;

const byteOrderMark = String.fromCharCode(0xfeff);
const formulaStart = /^[=+\-@\t\r]/;

/** Escapes one text cell: quotes when needed and neutralizes spreadsheet formulas. */
function escapeText(value: string, separator: string) {
  const safe = formulaStart.test(value) ? `'${value}` : value;
  return safe.includes(separator) || /["\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Builds a UTF-8 CSV (with BOM, for spreadsheet apps) using ";" so decimal commas stay intact.
 * Only text cells are formula-neutralized; numbers and money cells such as negative amounts are kept as they are.
 */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[], separator = ";"): string {
  const line = (cells: readonly CsvCell[]) => cells
    .map((cell) => cell === null ? "" : typeof cell === "number" ? String(cell)
      : typeof cell === "object" ? centsToCsvAmount(cell.cents) : escapeText(cell, separator))
    .join(separator);
  return `${byteOrderMark}${[line(header), ...rows.map(line)].join("\r\n")}\r\n`;
}

/** Integer cents as a plain decimal-comma amount ("-25,90"), without currency symbol or grouping. */
export function centsToCsvAmount(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError("Money must be integer cents");
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.trunc(absolute / 100)},${String(absolute % 100).padStart(2, "0")}`;
}
