import type { Client } from "./api";

/**
 * The list of clients of a business that keeps trips, as its owner reads it: who owes, how much, and who has stopped
 * paying. What is shown, in what order, and the sums over it. The numbers themselves are the server's.
 */

/** «Не платят 30+ дней»: owes more than 500 $ and has not paid for thirty days and more, as the report on the debts has it. */
export const LATE_OVER_MINOR = 50_000;
export const LATE_DAYS = 30;
/** From here the mark of the days is red. */
export const LONG_LATE_DAYS = 90;
/** Someone owes when it is more than a dollar: less is what is left over of rounding. */
const DEBTOR_OVER_MINOR = 100;

export type ClientFilter = "debtors" | "all" | "late";
export type ClientSort = "debt" | "code" | "days";

export const isDebtor = (client: Client) => (client.debtMinor ?? 0) > DEBTOR_OVER_MINOR;
export const isLate = (client: Client) => (client.debtMinor ?? 0) > LATE_OVER_MINOR && (client.daysUnpaid ?? 0) >= LATE_DAYS;

/** Codes in the order a person reads them: 9 before 10, 77 before 707. */
const byCode = (one: Client, other: Client) => one.code.localeCompare(other.code, "ru", { numeric: true });

/** What all the clients owe together and what was paid ahead (two sums, never one netted against the other), and those who do not pay. */
export function totalsOf(clients: readonly Client[]): { owedMinor: number; debtors: number; aheadMinor: number; late: number; lateMinor: number } {
  let owedMinor = 0;
  let debtors = 0;
  let aheadMinor = 0;
  let late = 0;
  let lateMinor = 0;
  for (const client of clients) {
    const debt = client.debtMinor ?? 0;
    if (debt > 0) owedMinor += debt;
    else aheadMinor -= debt;
    if (isDebtor(client)) debtors += 1;
    if (isLate(client)) {
      late += 1;
      lateMinor += debt;
    }
  }
  return { owedMinor, debtors, aheadMinor, late, lateMinor };
}

/** Whether what was typed finds the client: the beginning of the code, a part of the name, a part of the phone. */
function found(client: Client, typed: string): boolean {
  if (typed === "") return true;
  // A Latin A typed for the Cyrillic one of a code.
  const text = typed.replace(/^a/, "а");
  return client.code.toLowerCase().startsWith(text) || client.name.toLowerCase().includes(typed) || client.name.toLowerCase().includes(text) || (client.phone ?? "").includes(typed);
}

/** The clients to show: those the filter keeps and the search finds, in the order asked for. */
export function shownClients(clients: readonly Client[], options: { filter: ClientFilter; sort: ClientSort; search: string }): Client[] {
  const typed = options.search.trim().toLowerCase();
  const kept = clients.filter((client) => (options.filter === "all" || (options.filter === "late" ? isLate(client) : isDebtor(client))) && found(client, typed));
  const order: Record<ClientSort, (one: Client, other: Client) => number> = {
    // Who owes most first.
    debt: (one, other) => (other.debtMinor ?? 0) - (one.debtMinor ?? 0) || byCode(one, other),
    code: byCode,
    // Who has not paid longest first; among them only those who owe: someone who owes nothing is behind with nothing.
    days: (one, other) => Number(isDebtor(other)) - Number(isDebtor(one)) || (other.daysUnpaid ?? 0) - (one.daysUnpaid ?? 0) || (other.debtMinor ?? 0) - (one.debtMinor ?? 0) || byCode(one, other),
  };
  return kept.sort(order[options.sort]);
}

/** "2026-11-16" is "16.11"; with the year when it is not `today`'s: "16.11.25". */
export function shortDayOf(day: string, today: string): string {
  const short = `${day.slice(8, 10)}.${day.slice(5, 7)}`;
  return day.slice(0, 4) === today.slice(0, 4) ? short : `${short}.${day.slice(2, 4)}`;
}

/** The line under the name: «Оплата 16.11 · рейс 14.11». */
export function hintOf(client: Client, today: string): string {
  const paid = client.lastPaidDay ? `Оплата ${shortDayOf(client.lastPaidDay, today)}` : "Оплат не было";
  return client.lastTripDay ? `${paid} · рейс ${shortDayOf(client.lastTripDay, today)}` : paid;
}
