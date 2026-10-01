/** The form of a Russian word for a count: 1 запись, 2 записи, 5 записей, 11 записей, 21 запись. */
export function plural(count: number, one: string, few: string, many: string): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}
