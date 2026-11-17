import type { DebtReport, Named } from "./api";
import { plural } from "./plural";

/**
 * The words of the report on the debts of a day: what stands under the tiles, under the lists and in the notes of
 * each picture. The numbers are the server's (`DebtReport`); here they are only said, the way the business said them
 * when the pictures were made by hand off its card file.
 */

const NBSP = " ";

/** Whole dollars of a sum in cents, the thousands apart: 2857411 is "28 574". */
export function formatWhole(minor: number): string {
  const dollars = Math.round(Math.abs(minor) / 100);
  const digits = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return minor < 0 && dollars > 0 ? `−${digits}` : digits;
}

/** A change in whole dollars with its sign: "+2 661", "−3 000"; a dash for none. */
export function formatChange(minor: number): string {
  const dollars = Math.round(Math.abs(minor) / 100);
  if (dollars === 0) return "—";
  return `${minor > 0 ? "+" : "−"}${formatWhole(Math.abs(minor))}`;
}

/** Cents as the control sheet writes them: 73004700 is "730 047,00". */
export function formatCents(minor: number): string {
  const cents = Math.abs(Math.round(minor));
  const whole = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return `${minor < 0 ? "−" : ""}${whole},${String(cents % 100).padStart(2, "0")}`;
}

/** "2026-11-16" is "16.11". */
export const shortDay = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
/** "2026-10-17" is "17.10.26". */
export const yearDay = (day: string) => `${shortDay(day)}.${day.slice(2, 4)}`;
/** A day next to the day of the report: without the year when it is the same one. */
export const dayNear = (day: string, report: Pick<DebtReport, "day">) => (day.slice(0, 4) === report.day.slice(0, 4) ? shortDay(day) : yearDay(day));

/** A client as the report names them: «Шухрад (200)». */
export const who = (client: Named) => `${client.name}${NBSP}(${client.code})`;

const daysOf = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
/** How many days the report covers. */
export const periodDays = (report: Pick<DebtReport, "day" | "since">) => daysOf(report.since, report.day);

/** The period in a heading: «16.11» for a day, «14–16.11» inside a month, «30.10–02.11» across two. */
export function periodLabel(report: Pick<DebtReport, "day" | "since">): string {
  if (periodDays(report) <= 1) return shortDay(report.day);
  const first = new Date(Date.parse(`${report.since}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return first.slice(0, 7) === report.day.slice(0, 7) ? `${first.slice(8, 10)}–${shortDay(report.day)}` : `${shortDay(first)}–${shortDay(report.day)}`;
}

const clientsWord = (count: number) => `${count}${NBSP}${plural(count, "клиент", "клиента", "клиентов")}`;
const list = (items: readonly string[]) => items.join(", ");

/** A cash desk in «касса Москвы»: the cities the business has are known, any other is named as it is. */
export function deskOf(label: string): string {
  const known: Record<string, string> = { Москва: "Москвы", Андижан: "Андижана", Ташкент: "Ташкента", Коканд: "Коканда" };
  return known[label] ? `касса ${known[label]}` : `касса «${label}»`;
}

/** Under the tile of the debt of the day: «−19 817 за день», «+15 585 за 2 дня». */
export function changeCaption(report: DebtReport): string {
  const days = periodDays(report);
  const over = days <= 1 ? "за день" : `за ${days}${NBSP}${plural(days, "день", "дня", "дней")}`;
  const change = report.closingMinor - report.openingMinor;
  return Math.round(Math.abs(change) / 100) === 0 ? `без изменений ${over}` : `${formatChange(change)} ${over}`;
}

/** Under «Начислено»: «рейс 241 (05.11), 19 клиентов», or that no truck came. */
export function chargedCaption(report: DebtReport): string {
  const { trips } = report;
  if (trips.length === 0) return "рейсов не было";
  const clients = clientsWord(report.chargedClients);
  if (trips.length === 1) return `рейс ${trips[0]!.number} (${shortDay(trips[0]!.day)}), ${clients}`;
  const oneDay = trips.every((trip) => trip.day === trips[0]!.day);
  return oneDay
    ? `рейсы ${list(trips.map((trip) => String(trip.number)))} (${shortDay(trips[0]!.day)}), ${clients}`
    : `рейсы ${list(trips.map((trip) => `${trip.number} (${shortDay(trip.day)})`))}; ${clients}`;
}

/** Under «Оплачено»: «19 клиентов, все — касса Москвы», or what the other desks took of it. */
export function paidCaption(report: DebtReport, labelOf: (kassa: string) => string): string {
  if (report.payers.length === 0) return report.paidMinor === 0 ? "оплат не было" : "только возвраты клиентам";
  const clients = clientsWord(report.payers.length);
  if (report.paidElsewhere.length === 0) return `${clients}, все — ${deskOf(labelOf(report.primaryKassa))}`;
  return `${clients}, из них ${list(report.paidElsewhere.map((part) => `${labelOf(part.kassa)} ${formatWhole(part.amountMinor)}`))}`;
}

/** How many lines of a list of bars are drawn; the rest is said in one line under it. */
export const BARS_SHOWN = 8;
/** How many of the rest are named one by one. */
const REST_NAMED = 8;
/** With more left over than this, only the first are named. */
const REST_ALL = 12;

/**
 * The line under a list of bars: who else, and how much together. `noun`: what the people of the list are called when
 * all of them are shown («Все 8 плательщиков показаны»).
 */
export function restLine(rows: ReadonlyArray<Named & { amountMinor: number; closed?: boolean }>, noun: readonly [string, string, string]): string | null {
  if (rows.length <= 1) return null;
  if (rows.length <= BARS_SHOWN) return `Все ${rows.length}${NBSP}${plural(rows.length, noun[0], noun[1], noun[2])} показаны`;
  const rest = rows.slice(BARS_SHOWN);
  const sum = rest.reduce((all, row) => all + row.amountMinor, 0);
  const named = rest.length > REST_ALL ? rest.slice(0, REST_NAMED) : rest;
  const names = list(named.map((row) => `${who(row)} ${formatWhole(row.amountMinor)}${row.closed ? " — долг закрыт" : ""}`));
  const more = rest.length - named.length;
  const tail = more > 0 ? ` и ещё ${more} — меньше ${formatWhole(named[named.length - 1]!.amountMinor)} каждый` : "";
  return `Ещё ${clientsWord(rest.length)}: ${formatWhole(sum)} (${names}${tail})`;
}

/** At most this many names in a sentence of a note; the others are counted. */
const NAMED_IN_NOTE = 6;
function some(items: readonly string[]): string {
  if (items.length <= NAMED_IN_NOTE) return list(items);
  return `${list(items.slice(0, NAMED_IN_NOTE))} и ещё ${items.length - NAMED_IN_NOTE}`;
}

const afterArrival = (days: number) => (days === 0 ? "в день прибытия" : days === 1 ? "на следующий день" : `через ${days}${NBSP}дн.`);

/** What was written into the closed days, in words; the first sentence of the notes of the first picture. */
export function backdatedNote(report: DebtReport): string {
  const since = shortDay(report.since);
  const { backdated } = report;
  if (!backdated) return `Закрытие ${since} не сохранено — правки задним числом не проверялись.`;
  if (backdated.changes.length === 0) return `Задним числом до ${since} ничего не менялось — долг на ${since} тот же.`;
  const parts: string[] = [];
  for (const trip of backdated.trips) parts.push(`рейс ${trip.number} (${shortDay(trip.day)}) отмечен прибывшим после закрытия: +${formatWhole(trip.amountMinor)}, ${clientsWord(trip.clients)}`);
  parts.push(`изменился долг: ${some(backdated.changes.map((change) => `${who(change)} ${formatChange(change.changeMinor)}`))}`);
  const moved = report.openingMinor - backdated.thenMinor;
  const result =
    Math.round(Math.abs(moved) / 100) === 0
      ? `Общий долг на ${since} тот же: сумма перенесена между клиентами.`
      : `Поэтому долг на ${since} теперь ${formatWhole(report.openingMinor)}, а не ${formatWhole(backdated.thenMinor)}.`;
  return `Задним числом после закрытия ${since}: ${parts.join("; ")}. ${result}`;
}

/** The notes under the first picture: what was written into the past, the period day by day, and what is worth a word. */
export function movementNotes(report: DebtReport): string[] {
  const notes = [backdatedNote(report)];
  if (report.days.length > 1)
    notes.push(
      `${report.days
        .map((day) => {
          const trucks = day.trips.map((trip) => `рейс ${trip.number} +${formatWhole(trip.amountMinor)}`);
          const paid = day.paidMinor !== 0 ? [`оплачено ${formatWhole(day.paidMinor)}`] : [];
          const what = [...trucks, ...paid];
          return `${shortDay(day.day)} — ${what.length > 0 ? list(what) : "без движения"} → долг ${formatWhole(day.closingMinor)}`;
        })
        .join("; ")}.`,
    );

  const { events } = report;
  // The ones who paid for a truck, truck by truck.
  const byTrip = new Map<string, typeof events.paidTrip>();
  for (const paid of events.paidTrip) {
    const key = `${paid.trip}:${paid.daysAfter}`;
    byTrip.set(key, [...(byTrip.get(key) ?? []), paid]);
  }
  for (const paid of byTrip.values()) notes.push(`Оплатили рейс ${paid[0]!.trip} ${afterArrival(paid[0]!.daysAfter)}: ${some(paid.map((item) => `${who(item)} ${formatWhole(item.amountMinor)}`))}.`);
  if (events.closed.length > 0) notes.push(`Закрыли долг: ${some(events.closed.map(who))}.`);

  const year = report.day.slice(0, 4);
  const never = events.firstPayment.filter((first) => first.previousDay === null);
  const again = events.firstPayment.filter((first) => first.previousDay !== null);
  if (never.length > 0)
    notes.push(`${report.historyFrom.slice(0, 4) === year ? `Первая оплата в ${year}` : "Первая оплата за всё время"}: ${some(never.map((first) => `${who(first)} ${formatWhole(first.amountMinor)}`))}.`);
  if (again.length > 0) notes.push(`Первая оплата после перерыва: ${some(again.map((first) => `${who(first)} ${formatWhole(first.amountMinor)} (прошлая ${dayNear(first.previousDay!, report)})`))}.`);
  if (report.refunds.length > 0) notes.push(`Возвращено клиентам: ${some(report.refunds.map((refund) => `${who(refund)} ${formatWhole(refund.amountMinor)}`))}.`);
  if (events.crossed) {
    const thousands = formatWhole(events.crossed.boundaryMinor / 1000);
    notes.push(events.crossed.down ? `Долг опустился ниже ${thousands}${NBSP}тыс.` : `Долг поднялся выше ${thousands}${NBSP}тыс.`);
  }
  return notes;
}

const trucks = (numbers: readonly number[]) => (numbers.length === 1 ? `рейс ${numbers[0]}` : `рейсы ${list(numbers.map(String))}`);

/** The notes under the thirty who owe most. */
export function topNotes(report: DebtReport): string[] {
  const { top, debtors } = report;
  const notes = ["Красным в последней колонке — оплаты не было 30 дней и больше."];
  if (debtors.count === 0) return ["Должников нет."];
  const share = debtors.totalMinor > 0 ? Math.round((top.totalMinor / debtors.totalMinor) * 100) : 0;
  notes.push(
    debtors.count > top.rows.length
      ? `Всего должников ${debtors.count}, их долг ${formatWhole(debtors.totalMinor)}${NBSP}$; на топ-${top.rows.length} приходится ${formatWhole(top.totalMinor)}${NBSP}$ (${share}%).`
      : `Всего должников ${debtors.count}, их долг ${formatWhole(debtors.totalMinor)}${NBSP}$.`,
  );
  if (top.left.length === 0 && top.entered.length === 0) notes.push("Состав списка не изменился.");
  if (top.left.length > 0)
    notes.push(
      `Вышли из списка: ${some(
        top.left.map((left) => {
          const rest = left.debtMinor <= 100 ? "долг закрыт" : `осталось ${formatWhole(left.debtMinor)}`;
          if (left.paidMinor > 0) return `${who(left)} — оплата ${formatWhole(left.paidMinor)}, ${rest}`;
          return Math.round(Math.abs(left.changeMinor) / 100) === 0 ? `${who(left)} — долг не менялся, место заняли другие` : `${who(left)} — долг ${formatWhole(left.debtMinor)}, место заняли другие`;
        }),
      )}.`,
    );
  if (top.entered.length > 0)
    notes.push(
      `Вошли в список: ${some(
        top.entered.map((entered) => {
          if (entered.chargedMinor > 0) return `${who(entered)} — ${trucks(entered.trips)} на ${formatWhole(entered.chargedMinor)}`;
          return Math.round(Math.abs(entered.changeMinor) / 100) === 0 ? `${who(entered)} — без изменений долга` : `${who(entered)} — долг ${formatChange(entered.changeMinor)}`;
        }),
      )}.`,
    );
  if (top.moved.length > 0) notes.push(`${list(top.moved.map((moved) => `${who(moved)}: с ${moved.from}-го на ${moved.to}-е место`))}.`);
  if (top.crossed.length > 0) notes.push(`Перешли порог 30 дней: ${some(top.crossed.map((row) => `${who(row)} — ${row.days}`))}.`);
  const near = [...top.near].sort((one, other) => other.days - one.days);
  if (near.length > 0) notes.push(`Близко к порогу 30 дней: ${some(near.map((row) => `${who(row)} — ${row.days}`))}.`);
  const { backdated } = report;
  if (backdated && (backdated.topIn.length > 0 || backdated.topOut.length > 0)) {
    const parts = [backdated.topIn.length > 0 ? `вошли ${some(backdated.topIn.map(who))}` : null, backdated.topOut.length > 0 ? `вышли ${some(backdated.topOut.map(who))}` : null];
    notes.push(`После правок задним числом в списке на ${shortDay(report.since)}: ${parts.filter(Boolean).join("; ")}.`);
  }
  return notes;
}

/** What the report writes for a client with no payment since the history began: «в 2026 нет». */
export function neverPaid(report: Pick<DebtReport, "day" | "historyFrom">): string {
  return report.historyFrom.slice(0, 4) === report.day.slice(0, 4) ? `в ${report.day.slice(0, 4)} нет` : "оплат нет";
}

/** «31 клиент», «7 клиентов». */
export const clientsCount = clientsWord;

/** The notes under those who have not paid for long. */
export function overdueNotes(report: DebtReport): string[] {
  const { overdue } = report;
  const notes = [`Отбор: долг на ${shortDay(report.day)} больше 500${NBSP}$ и последняя оплата 30 и больше дней назад.`];
  if (overdue.rows.some((row) => row.lastPaidDay === null)) notes.push(`«${neverPaid(report)[0]!.toUpperCase()}${neverPaid(report).slice(1)}» — с ${dayNear(report.historyFrom, report)} ни одной оплаты (дни от ${dayNear(report.historyFrom, report)}).`);
  if (overdue.came.length === 0 && overdue.left.length === 0) notes.push("Состав списка не изменился.");
  if (overdue.came.length > 0)
    notes.push(
      `Новые: ${some(
        overdue.came.map((came) =>
          came.reason === "days"
            ? `${who(came)} — ${formatWhole(came.debtMinor)}, ${came.daysUnpaid}${NBSP}${plural(came.daysUnpaid, "день", "дня", "дней")} без оплаты (последняя ${came.lastPaidDay ? dayNear(came.lastPaidDay, report) : "—"})`
            : `${who(came)} — после рейса долг ${formatWhole(came.debtMinor)}, больше 500`,
        ),
      )}.`,
    );
  if (overdue.left.length > 0)
    notes.push(
      `Вышли из списка: ${some(
        overdue.left.map((left) => {
          const rest = left.debtMinor <= 100 ? "долг закрыт" : `осталось ${formatWhole(left.debtMinor)}`;
          return left.paidMinor > 0 ? `${who(left)} — оплата ${formatWhole(left.paidMinor)}, ${rest}` : `${who(left)} — долг стал ${formatWhole(left.debtMinor)}`;
        }),
      )}.`,
    );
  const cargo = overdue.rows.filter((row) => row.gotCargo);
  if (cargo.length > 0) notes.push(`Получили груз ${periodLabel(report)} и не платят: ${some(cargo.map((row) => `${who(row)} — ${row.daysUnpaid}${NBSP}дн. без оплаты`))}.`);
  const { backdated } = report;
  if (backdated && (backdated.overdueIn.length > 0 || backdated.overdueOut.length > 0)) {
    const parts = [backdated.overdueIn.length > 0 ? `вошли ${some(backdated.overdueIn.map(who))}` : null, backdated.overdueOut.length > 0 ? `вышли ${some(backdated.overdueOut.map(who))}` : null];
    notes.push(`После правок задним числом в списке на ${shortDay(report.since)}: ${parts.filter(Boolean).join("; ")}.`);
  }
  return notes;
}

const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
export const monthName = (month: string) => MONTHS[Number(month.slice(5, 7)) - 1] ?? month;

/** The notes under the control sheet: up to which day the last month runs, and a warning when it does not come to the debt of all. */
export function controlNotes(report: DebtReport): string[] {
  const notes: string[] = [];
  const last = report.control.months[report.control.months.length - 1];
  const nextDay = new Date(Date.parse(`${report.day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  if (last && nextDay.slice(0, 7) === report.day.slice(0, 7)) notes.push(`${monthName(last.month)} — по ${shortDay(report.day)} включительно.`);
  if (last && !report.control.agrees) notes.push(`Внимание: остаток на конец месяца (${formatCents(last.closingMinor)}) не сходится с долгом всех клиентов на ${shortDay(report.day)} (${formatCents(report.closingMinor)}).`);
  return notes;
}

/**
 * The marks of an axis that holds everything between `low` and `high`: round numbers, a step of 1, 2 or 5 times a
 * power of ten, about `wanted` steps of them. The first is at or under `low`, the last at or over `high`.
 */
export function axisTicks(low: number, high: number, wanted = 4): number[] {
  const top = high > low ? high : low + 1;
  const rough = (top - low) / wanted;
  const power = 10 ** Math.floor(Math.log10(rough));
  // Never finer than a dollar: an axis of money has no use for cents.
  const step = Math.max(1, [1, 2, 5, 10].map((times) => times * power).find((candidate) => candidate >= rough) ?? 10 * power);
  const ticks: number[] = [];
  for (let tick = Math.floor(low / step) * step; ; tick += step) {
    ticks.push(Math.round(tick));
    if (tick >= top) break;
  }
  return ticks;
}

/** A mark of an axis of dollars: thousands in short («700 тыс.») when every mark is a whole thousand, in full otherwise. */
export function axisLabel(dollars: number, ticks: readonly number[]): string {
  if (dollars === 0) return "0";
  const thousands = ticks.every((tick) => tick % 1000 === 0);
  return thousands ? `${formatWhole((dollars / 1000) * 100)}${NBSP}тыс.` : formatWhole(dollars * 100);
}

const SHORT_MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
export const shortMonth = (month: string) => SHORT_MONTHS[Number(month.slice(5, 7)) - 1] ?? month;

/** The notes under the picture of a month: when the debt was biggest and smallest, and what the numbers under the months are. */
export function dynamicsNotes(report: DebtReport): string[] {
  const { dynamics } = report;
  if (!dynamics || dynamics.days.length === 0) return [];
  let most = dynamics.days[0]!;
  let least = dynamics.days[0]!;
  for (const day of dynamics.days) {
    if (day.closingMinor > most.closingMinor) most = day;
    if (day.closingMinor < least.closingMinor) least = day;
  }
  const notes = [`Самый большой долг за месяц — ${formatWhole(most.closingMinor)} (${shortDay(most.day)}), самый маленький — ${formatWhole(least.closingMinor)} (${shortDay(least.day)}).`];
  if (dynamics.trips > 0) notes.push(`Рейсов прибыло: ${dynamics.trips}.`);
  notes.push(`Под названием месяца — остаток на конец месяца, тыс.${NBSP}$.`);
  return notes;
}
