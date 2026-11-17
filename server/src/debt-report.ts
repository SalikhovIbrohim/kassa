import type { ControlMonth, DebtBook } from "./client-debts.js";

/**
 * The report on the debts of the clients for a day of the cash desk, as the business read it every evening off its
 * card file: how the debt of all the clients moved since the day before (who paid, who was charged for a truck that
 * came), the thirty who owe most, those who have not paid for long, and the control sheet of the year.
 *
 * It is worked out from the book of the debts as it stands now (`DebtBook`), for the day asked for and for the day it
 * is compared with, so a day of the past reads the same as it would have then, unless something was written into
 * the past since. That is what the closing of a day is kept for (`Closing`): the report says what was changed in the
 * days already closed, and for whom.
 *
 * Everything here is whole cents and whole days; nothing asks the database or the clock.
 */

/** Someone owes when it is more than a dollar: less is what is left over of rounding. */
export const DEBTOR_OVER_MINOR = 100;
/** How many of those who owe most the report lists. */
export const TOP_SIZE = 30;
/** «Долго не платят»: owes more than 500 $ and has not paid for 30 days and more. */
export const OVERDUE_OVER_MINOR = 50_000;
export const OVERDUE_DAYS = 30;
/** The ones of them marked in red: 90 days and more. */
export const LONG_OVERDUE_DAYS = 90;
/** Close to the 30 days: three weeks without a payment. */
const NEAR_DAYS = 21;
/** The debt of all crossing a round sum is worth a word: every 50 000 $. */
const ROUND_STEP_MINOR = 5_000_000;
/** A move in the list of thirty worth a word: ten places. */
const MOVED_PLACES = 10;
/** A payment that is the sum of a truck counts as paying for that truck when the truck came within a week. */
const TRIP_PAID_WITHIN_DAYS = 7;
/** The sheet «Не платят больше 7 дней». */
export const UNPAID_SHEET_DAYS = 7;
/** The longest period a report covers, in days. */
export const MAX_PERIOD_DAYS = 92;

const DAY_MS = 86_400_000;
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DAY_MS;
/** How many days from one day to another: from 2026-10-17 to 2026-11-16 it is 30. */
export const daysBetween = (from: string, to: string) => Math.round(dayNumber(to) - dayNumber(from));
export const shiftDay = (day: string, days: number) => new Date((dayNumber(day) + days) * DAY_MS).toISOString().slice(0, 10);
/** A real day written YYYY-MM-DD. */
export const isDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(dayNumber(day)) && shiftDay(day, 0) === day;
/** Codes in the order a person reads them: 9 before 10, 77 before 707. */
const byCode = (one: string, other: string) => one.localeCompare(other, "en", { numeric: true });

export type Named = { code: string; name: string };

/** What was kept when a day closed (a row of `debt_closings`). */
export type Closing = {
  day: string;
  takenAt: Date;
  totalMinor: number;
  debts: Record<string, number>;
  top: string[];
  overdue: string[];
};

export type TopRow = Named & {
  place: number;
  debtMinor: number;
  /** The debt now less the debt on the day compared with. */
  changeMinor: number;
  /** The day of the last payment; null when there was none since the history began. */
  lastPaidDay: string | null;
  daysUnpaid: number;
  /** Was not among the thirty on the day compared with. */
  isNew: boolean;
};

export type OverdueRow = Named & {
  debtMinor: number;
  lastPaidDay: string | null;
  daysUnpaid: number;
  /** The day the last truck with cargo of this client came. */
  lastTripDay: string | null;
  isNew: boolean;
  /** Got cargo in the period of the report, and still does not pay. */
  gotCargo: boolean;
};

export type Backdated = {
  /** When the closing of the day compared with was kept. */
  takenAt: string;
  /** What all the clients owed on that day, as the closing has it. `openingMinor` of the report is what it is now. */
  thenMinor: number;
  /** Whose debt of that day is another now, and by how much (now less then); biggest change first. */
  changes: Array<Named & { changeMinor: number }>;
  /** Trucks that came on that day or before and were marked as arrived only after the closing: where a change comes from. */
  trips: Array<{ number: number; day: string; amountMinor: number; clients: number }>;
  /** Who is among the thirty of that day now and was not in the closing, and the other way round; the same for those who do not pay. */
  topIn: Named[];
  topOut: Named[];
  overdueIn: Named[];
  overdueOut: Named[];
};

export type DebtReport = {
  /** The day the report is of, and the day it is compared with (the closing before): the period is after `since`, up to `day`. */
  day: string;
  since: string;
  /** The first day of the history: a client with no payment at all has not paid since then. */
  historyFrom: string;
  /** The main cash desk; a payment another desk took is marked with that desk. */
  primaryKassa: string;

  /** What all the clients owed at the end of `since` and at the end of `day`. */
  openingMinor: number;
  closingMinor: number;
  chargedMinor: number;
  paidMinor: number;
  /** The trucks that came in the period. */
  trips: Array<{ number: number; day: string; amountMinor: number; clients: number }>;
  chargedClients: number;
  /** What the other desks took, of what was paid. */
  paidElsewhere: Array<{ kassa: string; amountMinor: number }>;
  /** Day by day, when the period is longer than one. */
  days: Array<{ day: string; trips: Array<{ number: number; amountMinor: number }>; chargedMinor: number; paidMinor: number; closingMinor: number }>;

  /** Everybody who paid in the period, biggest first. `kassas`: the desks other than the main one that took it. */
  payers: Array<Named & { amountMinor: number; kassas: string[]; debtMinor: number; closed: boolean }>;
  /** Clients who were given more back than they paid. */
  refunds: Array<Named & { amountMinor: number }>;
  /** Everybody a truck was charged to in the period, biggest first. */
  charged: Array<Named & { amountMinor: number; trips: number[] }>;

  events: {
    /** Owed, paid, and owes nothing any more. */
    closed: Named[];
    /** Paid just what their last truck came to, the day it came or within the week. */
    paidTrip: Array<Named & { trip: number; amountMinor: number; daysAfter: number; closed: boolean }>;
    /** The first payment since the history began (`previousDay` null), or the first in a month and more. */
    firstPayment: Array<Named & { amountMinor: number; previousDay: string | null }>;
    /** The debt of all went through a round sum. */
    crossed: { boundaryMinor: number; down: boolean } | null;
  };
  /** What was written into the days already closed; null when no closing of `since` was kept. */
  backdated: Backdated | null;

  /** Everybody who owes more than a dollar. */
  debtors: { count: number; totalMinor: number };
  top: {
    rows: TopRow[];
    totalMinor: number;
    left: Array<Named & { paidMinor: number; debtMinor: number; changeMinor: number }>;
    entered: Array<Named & { chargedMinor: number; trips: number[]; changeMinor: number }>;
    moved: Array<Named & { from: number; to: number }>;
    /** Three weeks and more without a payment, but not yet thirty days. */
    near: Array<Named & { days: number }>;
    /** Thirty days without a payment came in this period. */
    crossed: Array<Named & { days: number }>;
  };
  overdue: {
    rows: OverdueRow[];
    totalMinor: number;
    /** How many of them have not paid for 90 days and more. */
    long: number;
    left: Array<Named & { paidMinor: number; debtMinor: number }>;
    /** The new ones and why: the thirty days came (`days`), or a truck took the debt over 500 $ (`debt`). */
    came: Array<Named & { debtMinor: number; daysUnpaid: number; lastPaidDay: string | null; reason: "days" | "debt" }>;
  };
  control: { year: number; months: ControlMonth[]; agrees: boolean };
};

type Charge = { trip: number; day: string; minor: number };
type Payment = { day: string; minor: number; kassa: string | null };
type Ledger = { code: string; name: string; phone: string | null; openingMinor: number; charges: Charge[]; payments: Payment[] };

/** The book, client by client: the trucks and the payments of each, oldest first. */
function ledgersOf(book: DebtBook): Ledger[] {
  const byClient = new Map<string, Ledger>(book.clients.map((client) => [client.code, { ...client, charges: [], payments: [] }]));
  for (const charge of book.charges) byClient.get(charge.code)?.charges.push({ trip: charge.trip, day: charge.day, minor: charge.minor });
  for (const payment of book.payments) byClient.get(payment.code)?.payments.push({ day: payment.day, minor: payment.minor, kassa: payment.kassa });
  const ledgers = [...byClient.values()];
  for (const ledger of ledgers) {
    ledger.charges.sort((one, other) => (one.day < other.day ? -1 : one.day > other.day ? 1 : one.trip - other.trip));
    // A stable sort: the payments of one day stay in the order the book has them.
    ledger.payments.sort((one, other) => (one.day < other.day ? -1 : one.day > other.day ? 1 : 0));
  }
  return ledgers;
}

/** The first day of the history: the first of January of the year its oldest line is in (of the year of `day`, with no line at all). */
function historyStart(book: DebtBook, day: string): string {
  let first = day;
  for (const charge of book.charges) if (charge.day < first) first = charge.day;
  for (const payment of book.payments) if (payment.day < first) first = payment.day;
  return `${first.slice(0, 4)}-01-01`;
}

/** Where a client stands at the end of a day. */
type Standing = {
  debtMinor: number;
  /** The day of the last payment up to then, and what was paid on it. */
  lastPaidDay: string | null;
  lastPaidMinor: number;
  lastTrip: Charge | null;
  daysUnpaid: number;
};

function standingOn(ledger: Ledger, day: string, historyFrom: string): Standing {
  let debtMinor = ledger.openingMinor;
  let lastTrip: Charge | null = null;
  let lastPaidDay: string | null = null;
  let lastPaidMinor = 0;
  for (const charge of ledger.charges) {
    if (charge.day > day) break;
    debtMinor += charge.minor;
    lastTrip = charge;
  }
  for (const payment of ledger.payments) {
    if (payment.day > day) break;
    debtMinor -= payment.minor;
    if (payment.minor <= 0) continue;
    lastPaidMinor = payment.day === lastPaidDay ? lastPaidMinor + payment.minor : payment.minor;
    lastPaidDay = payment.day;
  }
  return { debtMinor, lastPaidDay, lastPaidMinor, lastTrip, daysUnpaid: Math.max(0, daysBetween(lastPaidDay ?? historyFrom, day)) };
}

type Placed = { ledger: Ledger; standing: Standing };

/** The lists of a day: everybody who owes (biggest debt first), the thirty at the top, those who do not pay. */
function listsOf(placed: readonly Placed[]) {
  const debtors = placed
    .filter((item) => item.standing.debtMinor > DEBTOR_OVER_MINOR)
    .sort((one, other) => other.standing.debtMinor - one.standing.debtMinor || byCode(one.ledger.code, other.ledger.code));
  return {
    debtors,
    top: debtors.slice(0, TOP_SIZE),
    overdue: debtors.filter((item) => item.standing.debtMinor > OVERDUE_OVER_MINOR && item.standing.daysUnpaid >= OVERDUE_DAYS),
  };
}

const named = (ledger: Ledger): Named => ({ code: ledger.code, name: ledger.name });
const total = (placed: readonly Placed[]) => placed.reduce((sum, item) => sum + item.standing.debtMinor, 0);

/** What is kept when a day closes: what each client owed at its end, and the two lists as the report has them. */
export function closingOf(book: DebtBook, day: string): Omit<Closing, "day" | "takenAt"> {
  const historyFrom = historyStart(book, day);
  const placed = ledgersOf(book).map((ledger) => ({ ledger, standing: standingOn(ledger, day, historyFrom) }));
  const lists = listsOf(placed);
  const debts: Record<string, number> = {};
  for (const item of placed) if (item.standing.debtMinor !== 0) debts[item.ledger.code] = item.standing.debtMinor;
  return { totalMinor: total(placed), debts, top: lists.top.map((item) => item.ledger.code), overdue: lists.overdue.map((item) => item.ledger.code) };
}

export function debtReport(book: DebtBook, options: { day: string; since: string; primaryKassa: string; closing?: Closing | null }): DebtReport {
  const { day, since, primaryKassa } = options;
  const historyFrom = historyStart(book, day);
  const ledgers = ledgersOf(book);
  const inPeriod = (when: string) => when > since && when <= day;

  // Every client, where they stood then and where they stand now, and what happened to them in between.
  const clients = ledgers.map((ledger) => {
    const before = standingOn(ledger, since, historyFrom);
    const now = standingOn(ledger, day, historyFrom);
    const trips = ledger.charges.filter((charge) => inPeriod(charge.day));
    const payments = ledger.payments.filter((payment) => inPeriod(payment.day));
    const paid = payments.reduce((sum, payment) => sum + payment.minor, 0);
    const taken = payments.filter((payment) => payment.minor > 0);
    return {
      ledger,
      before,
      now,
      trips,
      payments,
      chargedMinor: trips.reduce((sum, trip) => sum + trip.minor, 0),
      paidMinor: paid,
      firstPayDay: taken[0]?.day ?? null,
      lastPayDay: taken[taken.length - 1]?.day ?? null,
      // The other desks that took money of this client, in the order they first did.
      kassas: [...new Set(taken.map((payment) => payment.kassa).filter((kassa): kassa is string => kassa !== null && kassa !== primaryKassa))],
    };
  });
  const byClient = new Map(clients.map((client) => [client.ledger.code, client]));

  const listsBefore = listsOf(clients.map((client) => ({ ledger: client.ledger, standing: client.before })));
  const listsNow = listsOf(clients.map((client) => ({ ledger: client.ledger, standing: client.now })));
  const openingMinor = clients.reduce((sum, client) => sum + client.before.debtMinor, 0);
  const closingMinor = clients.reduce((sum, client) => sum + client.now.debtMinor, 0);
  const chargedMinor = clients.reduce((sum, client) => sum + client.chargedMinor, 0);
  const paidMinor = clients.reduce((sum, client) => sum + client.paidMinor, 0);
  const closedNow = (client: (typeof clients)[number]) => client.before.debtMinor > DEBTOR_OVER_MINOR && client.now.debtMinor <= DEBTOR_OVER_MINOR;

  // The trucks of the period, and the period day by day.
  const tripsByNumber = new Map<number, { number: number; day: string; amountMinor: number; clients: number }>();
  for (const client of clients)
    for (const trip of client.trips) {
      const known = tripsByNumber.get(trip.trip) ?? { number: trip.trip, day: trip.day, amountMinor: 0, clients: 0 };
      known.amountMinor += trip.minor;
      known.clients += 1;
      tripsByNumber.set(trip.trip, known);
    }
  const trips = [...tripsByNumber.values()].sort((one, other) => (one.day < other.day ? -1 : one.day > other.day ? 1 : one.number - other.number));

  const days: DebtReport["days"] = [];
  if (daysBetween(since, day) > 1) {
    let running = openingMinor;
    for (let at = shiftDay(since, 1); at <= day; at = shiftDay(at, 1)) {
      const ofDay = trips.filter((trip) => trip.day === at);
      const charged = ofDay.reduce((sum, trip) => sum + trip.amountMinor, 0);
      let paid = 0;
      for (const client of clients) for (const payment of client.payments) if (payment.day === at) paid += payment.minor;
      running += charged - paid;
      days.push({ day: at, trips: ofDay.map((trip) => ({ number: trip.number, amountMinor: trip.amountMinor })), chargedMinor: charged, paidMinor: paid, closingMinor: running });
    }
  }

  const elsewhere = new Map<string, number>();
  for (const client of clients)
    for (const payment of client.payments)
      if (payment.kassa !== null && payment.kassa !== primaryKassa) elsewhere.set(payment.kassa, (elsewhere.get(payment.kassa) ?? 0) + payment.minor);

  const bySum = <Row extends Named & { amountMinor: number }>(rows: Row[]) => rows.sort((one, other) => other.amountMinor - one.amountMinor || byCode(one.code, other.code));
  const payers = bySum(
    clients
      .filter((client) => client.paidMinor > 0)
      .map((client) => ({ ...named(client.ledger), amountMinor: client.paidMinor, kassas: client.kassas, debtMinor: client.now.debtMinor, closed: closedNow(client) })),
  );
  const refunds = bySum(clients.filter((client) => client.paidMinor < 0).map((client) => ({ ...named(client.ledger), amountMinor: -client.paidMinor })));
  const charged = bySum(
    clients.filter((client) => client.chargedMinor > 0).map((client) => ({ ...named(client.ledger), amountMinor: client.chargedMinor, trips: client.trips.map((trip) => trip.trip) })),
  );

  // What is worth a word.
  const paying = payers.map((payer) => byClient.get(payer.code)!);
  const paidTrip = paying.flatMap((client) => {
    const trip = client.now.lastTrip;
    if (!trip || client.lastPayDay === null) return [];
    const daysAfter = daysBetween(trip.day, client.lastPayDay);
    if (daysAfter < 0 || daysBetween(trip.day, day) > TRIP_PAID_WITHIN_DAYS) return [];
    if (Math.abs(client.paidMinor - trip.minor) >= 100) return [];
    return [{ ...named(client.ledger), trip: trip.trip, amountMinor: client.paidMinor, daysAfter, closed: closedNow(client) }];
  });
  const firstPayment = paying.flatMap((client) => {
    const previousDay = client.before.lastPaidDay;
    if (previousDay !== null && daysBetween(previousDay, client.firstPayDay!) < OVERDUE_DAYS) return [];
    return [{ ...named(client.ledger), amountMinor: client.paidMinor, previousDay }];
  });
  const stepBefore = Math.floor(openingMinor / ROUND_STEP_MINOR);
  const stepNow = Math.floor(closingMinor / ROUND_STEP_MINOR);
  const crossed = stepNow < stepBefore ? { boundaryMinor: stepBefore * ROUND_STEP_MINOR, down: true } : stepNow > stepBefore ? { boundaryMinor: stepNow * ROUND_STEP_MINOR, down: false } : null;

  // The thirty who owe most.
  const placeBefore = new Map(listsBefore.top.map((item, index) => [item.ledger.code, index + 1]));
  const placeNow = new Map(listsNow.top.map((item, index) => [item.ledger.code, index + 1]));
  const period = daysBetween(since, day);
  const topRows: TopRow[] = listsNow.top.map((item, index) => {
    const client = byClient.get(item.ledger.code)!;
    return {
      ...named(item.ledger),
      place: index + 1,
      debtMinor: client.now.debtMinor,
      changeMinor: client.now.debtMinor - client.before.debtMinor,
      lastPaidDay: client.now.lastPaidDay,
      daysUnpaid: client.now.daysUnpaid,
      isNew: !placeBefore.has(item.ledger.code),
    };
  });
  const top: DebtReport["top"] = {
    rows: topRows,
    totalMinor: total(listsNow.top),
    left: listsBefore.top
      .filter((item) => !placeNow.has(item.ledger.code))
      .map((item) => {
        const client = byClient.get(item.ledger.code)!;
        return { ...named(item.ledger), paidMinor: client.paidMinor, debtMinor: client.now.debtMinor, changeMinor: client.now.debtMinor - client.before.debtMinor };
      }),
    entered: topRows
      .filter((row) => row.isNew)
      .map((row) => {
        const client = byClient.get(row.code)!;
        return { code: row.code, name: row.name, chargedMinor: client.chargedMinor, trips: client.trips.map((trip) => trip.trip), changeMinor: row.changeMinor };
      }),
    moved: topRows.flatMap((row) => {
      const from = placeBefore.get(row.code);
      return from !== undefined && Math.abs(from - row.place) >= MOVED_PLACES ? [{ code: row.code, name: row.name, from, to: row.place }] : [];
    }),
    near: topRows.filter((row) => row.daysUnpaid >= NEAR_DAYS && row.daysUnpaid < OVERDUE_DAYS).map((row) => ({ code: row.code, name: row.name, days: row.daysUnpaid })),
    crossed: topRows.filter((row) => row.daysUnpaid >= OVERDUE_DAYS && row.daysUnpaid - period < OVERDUE_DAYS).map((row) => ({ code: row.code, name: row.name, days: row.daysUnpaid })),
  };

  // Those who have not paid for long.
  const overdueBefore = new Set(listsBefore.overdue.map((item) => item.ledger.code));
  const overdueNow = new Set(listsNow.overdue.map((item) => item.ledger.code));
  const overdueRows: OverdueRow[] = listsNow.overdue.map((item) => {
    const { standing } = item;
    return {
      ...named(item.ledger),
      debtMinor: standing.debtMinor,
      lastPaidDay: standing.lastPaidDay,
      daysUnpaid: standing.daysUnpaid,
      lastTripDay: standing.lastTrip?.day ?? null,
      isNew: !overdueBefore.has(item.ledger.code),
      gotCargo: standing.lastTrip !== null && inPeriod(standing.lastTrip.day),
    };
  });
  const overdue: DebtReport["overdue"] = {
    rows: overdueRows,
    totalMinor: total(listsNow.overdue),
    long: overdueRows.filter((row) => row.daysUnpaid >= LONG_OVERDUE_DAYS).length,
    left: listsBefore.overdue
      .filter((item) => !overdueNow.has(item.ledger.code))
      .map((item) => {
        const client = byClient.get(item.ledger.code)!;
        return { ...named(item.ledger), paidMinor: client.paidMinor, debtMinor: client.now.debtMinor };
      }),
    came: overdueRows
      .filter((row) => row.isNew)
      .map((row) => ({
        code: row.code,
        name: row.name,
        debtMinor: row.debtMinor,
        daysUnpaid: row.daysUnpaid,
        lastPaidDay: row.lastPaidDay,
        reason: byClient.get(row.code)!.before.debtMinor > OVERDUE_OVER_MINOR ? ("days" as const) : ("debt" as const),
      })),
  };

  const control = controlOf(book, day);
  return {
    day,
    since,
    historyFrom,
    primaryKassa,
    openingMinor,
    closingMinor,
    chargedMinor,
    paidMinor,
    trips,
    chargedClients: charged.length,
    paidElsewhere: [...elsewhere].filter(([, amountMinor]) => amountMinor !== 0).map(([kassa, amountMinor]) => ({ kassa, amountMinor })),
    days,
    payers,
    refunds,
    charged,
    events: { closed: clients.filter((client) => client.paidMinor > 0 && closedNow(client)).map((client) => named(client.ledger)), paidTrip, firstPayment, crossed },
    backdated: options.closing ? backdatedOf(book, options.closing, clients, listsBefore) : null,
    debtors: { count: listsNow.debtors.length, totalMinor: total(listsNow.debtors) },
    top,
    overdue,
    control: { year: Number(day.slice(0, 4)), months: control, agrees: (control[control.length - 1]?.closingMinor ?? openingMinor) === closingMinor },
  };
}

/** What differs between the day as it was closed and the same day as the book has it now. */
function backdatedOf(
  book: DebtBook,
  closing: Closing,
  clients: ReadonlyArray<{ ledger: Ledger; before: Standing }>,
  listsBefore: ReturnType<typeof listsOf>,
): Backdated {
  const names = new Map(clients.map((client) => [client.ledger.code, client.ledger.name]));
  const who = (code: string): Named => ({ code, name: names.get(code) ?? "" });
  const now = new Map(clients.map((client) => [client.ledger.code, client.before.debtMinor]));
  const changes = [...new Set([...now.keys(), ...Object.keys(closing.debts)])]
    .map((code) => ({ ...who(code), changeMinor: (now.get(code) ?? 0) - (closing.debts[code] ?? 0) }))
    .filter((change) => change.changeMinor !== 0)
    .sort((one, other) => Math.abs(other.changeMinor) - Math.abs(one.changeMinor) || byCode(one.code, other.code));

  // A truck that came on a day already closed and was marked as arrived after the closing.
  const late = new Map<number, { number: number; day: string; amountMinor: number; clients: number }>();
  if (changes.length > 0)
    for (const charge of book.charges) {
      const at = book.arrivedAt.get(charge.trip);
      if (charge.day > closing.day || !at || at.getTime() <= closing.takenAt.getTime()) continue;
      const known = late.get(charge.trip) ?? { number: charge.trip, day: charge.day, amountMinor: 0, clients: 0 };
      known.amountMinor += charge.minor;
      known.clients += 1;
      late.set(charge.trip, known);
    }

  const topNow = listsBefore.top.map((item) => item.ledger.code);
  const overdueNow = listsBefore.overdue.map((item) => item.ledger.code);
  const only = (list: readonly string[], other: readonly string[]) => list.filter((code) => !other.includes(code)).map(who);
  return {
    takenAt: closing.takenAt.toISOString(),
    thenMinor: closing.totalMinor,
    changes,
    trips: [...late.values()].sort((one, other) => one.number - other.number),
    // The lists are told apart only when a debt was changed: without that they are the same by themselves.
    topIn: changes.length > 0 ? only(topNow, closing.top) : [],
    topOut: changes.length > 0 ? only(closing.top, topNow) : [],
    overdueIn: changes.length > 0 ? only(overdueNow, closing.overdue) : [],
    overdueOut: changes.length > 0 ? only(closing.overdue, overdueNow) : [],
  };
}

/**
 * The control sheet of the year of `day`, up to that day: month by month what all the clients owed at the start,
 * what the trucks that came added, what was paid, what was owed at the end. Added up from the lines of the book by
 * month, not from the debts of the clients, so that the two can be held against each other.
 */
function controlOf(book: DebtBook, day: string): ControlMonth[] {
  const year = day.slice(0, 4);
  const directory = new Set(book.clients.map((client) => client.code));
  let debt = book.clients.reduce((sum, client) => sum + client.openingMinor, 0);
  const moved = new Map<string, { charged: number; paid: number }>();
  const add = (code: string, when: string, charged: number, paid: number) => {
    if (!directory.has(code) || when > day) return;
    if (when.slice(0, 4) < year) {
      debt += charged - paid;
      return;
    }
    const month = when.slice(0, 7);
    const known = moved.get(month) ?? { charged: 0, paid: 0 };
    known.charged += charged;
    known.paid += paid;
    moved.set(month, known);
  };
  for (const charge of book.charges) add(charge.code, charge.day, charge.minor, 0);
  for (const payment of book.payments) add(payment.code, payment.day, 0, payment.minor);

  const months: ControlMonth[] = [];
  for (let number = 1; number <= Number(day.slice(5, 7)); number++) {
    const month = `${year}-${String(number).padStart(2, "0")}`;
    const { charged, paid } = moved.get(month) ?? { charged: 0, paid: 0 };
    months.push({ month, openingMinor: debt, chargedMinor: charged, paidMinor: paid, closingMinor: debt + charged - paid });
    debt += charged - paid;
  }
  return months;
}

/** A line of the sheet «Не платят больше 7 дней»: someone who owes a dollar and more and has not paid for over a week. */
export type UnpaidRow = Named & {
  phone: string | null;
  debtMinor: number;
  lastPaidDay: string | null;
  lastPaidMinor: number;
  daysUnpaid: number;
  lastTrip: { number: number; day: string; amountMinor: number } | null;
  /** What they paid in the year of the sheet, less what was given back. */
  paidInYearMinor: number;
};

export function unpaidRows(book: DebtBook, day: string): UnpaidRow[] {
  const historyFrom = historyStart(book, day);
  const year = day.slice(0, 4);
  return ledgersOf(book)
    .map((ledger) => ({ ledger, standing: standingOn(ledger, day, historyFrom) }))
    .filter((item) => item.standing.debtMinor >= DEBTOR_OVER_MINOR && item.standing.daysUnpaid > UNPAID_SHEET_DAYS)
    .sort((one, other) => other.standing.debtMinor - one.standing.debtMinor || byCode(one.ledger.code, other.ledger.code))
    .map(({ ledger, standing }) => ({
      ...named(ledger),
      phone: ledger.phone,
      debtMinor: standing.debtMinor,
      lastPaidDay: standing.lastPaidDay,
      lastPaidMinor: standing.lastPaidMinor,
      daysUnpaid: standing.daysUnpaid,
      lastTrip: standing.lastTrip ? { number: standing.lastTrip.trip, day: standing.lastTrip.day, amountMinor: standing.lastTrip.minor } : null,
      paidInYearMinor: ledger.payments.filter((payment) => payment.day <= day && payment.day.slice(0, 4) === year).reduce((sum, payment) => sum + payment.minor, 0),
    }));
}
