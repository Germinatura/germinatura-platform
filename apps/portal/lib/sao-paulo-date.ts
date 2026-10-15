/**
 * The calendar day in America/Sao_Paulo ("2026-10-13"), the day the operation lives in. Never the UTC day: at 22:30 in
 * São Paulo it is already the next day in UTC.
 */
export function todayInSaoPaulo(now: Date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
