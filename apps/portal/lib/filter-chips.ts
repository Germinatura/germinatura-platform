/** A calendar day typed in a date input ("2026-10-13") as written in Brazil ("13/10/2026"), without time zones. */
export function dayLabel(day: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : day;
}

/** The chip text of a period filter; either bound may be open. */
export function periodLabel(from: string, to: string, prefix = "Período") {
  if (from && to) return `${prefix}: ${dayLabel(from)} a ${dayLabel(to)}`;
  if (from) return `${prefix}: desde ${dayLabel(from)}`;
  return `${prefix}: até ${dayLabel(to)}`;
}
