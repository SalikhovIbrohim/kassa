export type Role = "cashier" | "viewer";

export type User = {
  login: string;
  displayName: string;
  role: Role;
  /** A Telegram account is linked to this login, so that the Mini App signs in by itself. */
  telegramLinked?: boolean;
};

/** The server could not be reached at all (no connection, server down). */
export class NetworkError extends Error {}

/** The session ended (expired, revoked, logged out elsewhere): show the login screen. */
export class SessionExpiredError extends Error {}

/** The whole exchange, the answer read to its end included, must be over in this time. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * A request that cannot hang: a phone with bars but no data (or a server that is stuck) leaves a fetch
 * waiting for as long as the system likes. After the time is up it is a lost connection, like any other.
 * The timer is left running when the answer has begun, so that a body that never ends is cut off too;
 * aborting what is finished does nothing.
 */
async function request(path: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(path, { credentials: "same-origin", ...init, signal: controller.signal });
  } catch {
    throw new NetworkError(`Cannot reach the server for ${path}`);
  }
}

/** The person behind the session cookie, or null when nobody is logged in. */
export async function fetchCurrentUser(): Promise<User | null> {
  // Short: when it does not answer, the app opens with the cashier it remembers, and the entries wait on the phone.
  const response = await request("/api/me", undefined, 5_000);
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`Unexpected status ${response.status} from /api/me`);
  const body = (await response.json()) as { user: User };
  return body.user;
}

export type LoginResult =
  | { ok: true; user: User }
  | { ok: false; reason: "wrong-credentials" | "failed" }
  /** Too many wrong passwords, or the server is busy: try again after this many seconds. */
  | { ok: false; reason: "too-many-attempts" | "busy"; retryAfterSeconds: number };

export async function logIn(login: string, password: string): Promise<LoginResult> {
  const response = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login, password }),
  });
  if (response.ok) {
    const body = (await response.json()) as { user: User };
    return { ok: true, user: body.user };
  }
  if (response.status === 429 || response.status === 503) {
    const body = (await response.json().catch(() => null)) as { retryAfterSeconds?: number } | null;
    return {
      ok: false,
      reason: response.status === 429 ? "too-many-attempts" : "busy",
      retryAfterSeconds: body?.retryAfterSeconds ?? Number(response.headers.get("retry-after") ?? 30),
    };
  }
  return { ok: false, reason: response.status === 401 ? "wrong-credentials" : "failed" };
}

export type TelegramLoginResult =
  | { ok: true; user: User }
  /** The Telegram account is not linked to any login, or the launch data was refused (forged, old), or the server has no bot. */
  | { ok: false; reason: "not-linked" | "invalid" | "disabled" | "failed" };

/** Signs in with what Telegram gave when it opened the Mini App. Never throws on an answer, only on no connection. */
export async function loginWithTelegram(initData: string): Promise<TelegramLoginResult> {
  const response = await request("/api/telegram/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData }),
  });
  if (response.ok) {
    const body = (await response.json()) as { user: User };
    return { ok: true, user: body.user };
  }
  if (response.status === 403) return { ok: false, reason: "not-linked" };
  if (response.status === 401) return { ok: false, reason: "invalid" };
  if (response.status === 404) return { ok: false, reason: "disabled" };
  return { ok: false, reason: "failed" };
}

/** Links the Telegram account that opened the Mini App to the login that is signed in. */
export async function linkTelegram(initData: string): Promise<"linked" | "taken" | "invalid" | "failed"> {
  const response = await request("/api/telegram/link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData }),
  });
  if (response.ok) return "linked";
  if (response.status === 409) return "taken";
  if (response.status === 401 || response.status === 404) return "invalid";
  return "failed";
}

/** Returns false when the server could not end the session. */
export async function logOut(): Promise<boolean> {
  const response = await request("/api/logout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return response.ok;
}

// ---- Operations and balances ----

import type { Currency } from "./money";

export type Balance = { currency: Currency; amountMinor: number };

export type Operation = {
  id: string;
  type: "income" | "expense";
  amountMinor: number;
  currency: Currency;
  /** Rubles for one dollar, times 10 000: the rate of a ruble entry. Null for dollars, and for a ruble expense without one. */
  rateE4: number | null;
  /** What the entry is in dollars, and by which rate: its own, or the average of its shift (an expense without one, once the shift is closed). Null while there is no rate. */
  usdMinor: number | null;
  rateSource: "own" | "shift" | null;
  /** Only expenses have a category. */
  category: string | null;
  recipient: string | null;
  clientCode: string | null;
  comment: string | null;
  author: { login: string; displayName: string };
  createdAt: string;
  /** The shift it was entered in; null for an entry made before there were shifts or outside the author's own shift. */
  shiftId: string | null;
  /** How many times it was corrected or deleted; 0 means as first written. */
  revision: number;
  /** Set when the operation was deleted: only the viewer ever receives such operations. */
  deletedAt: string | null;
  deletedBy: { login: string; displayName: string } | null;
};

export type CategoryKind = "income" | "expense";

/** A category of incomes or expenses, as the owner keeps the lists. */
export type Category = {
  code: string;
  kind: CategoryKind;
  label: string;
  /** Where it stands in its list. */
  sortOrder: number;
  /** Not offered for new entries any more; old entries still read it. */
  archived: boolean;
  /** An entry of this category names a client (its code), and an entry of any other does not. */
  requiresClient: boolean;
  /** False for the money handed to the owner: it is not a cost of the business. */
  countsAsCost: boolean;
  /** The Telegram group is told of the entries of this category. */
  notifyGroup: boolean;
};

/** The categories of one kind that a new entry may have, in the order of the owner's list. */
export function activeCategories(all: readonly Category[], kind: CategoryKind): Category[] {
  return all.filter((item) => item.kind === kind && !item.archived);
}

/** The income category that an entry without a category is: what the entries of before there were categories are. */
export const DEFAULT_INCOME_CATEGORY = "client_payment";

/** What to call an operation: an expense by its category, an income by its category too unless it is a payment of a client ("Приход"). */
export function operationTitle(type: "income" | "expense", category: string | null, labels: ReadonlyMap<string, string>): string {
  if (type === "expense") return labels.get(category ?? "") ?? "Расход";
  return category !== null && category !== DEFAULT_INCOME_CATEGORY ? (labels.get(category) ?? "Приход") : "Приход";
}

export async function fetchBalances(): Promise<Balance[]> {
  const response = await request("/api/balances");
  if (response.status === 401) throw new SessionExpiredError("Session ended");
  if (!response.ok) throw new Error(`Unexpected status ${response.status} from /api/balances`);
  return ((await response.json()) as { balances: Balance[] }).balances;
}

export async function fetchDefaultCurrency(): Promise<Currency> {
  const response = await request("/api/operations/defaults");
  if (!response.ok) return "RUB";
  return ((await response.json()) as { currency: Currency }).currency;
}

/** Codes typed before that start with `prefix`. Never throws: suggestions are optional. */
export async function fetchClientCodes(prefix: string): Promise<string[]> {
  try {
    const response = await request(`/api/client-codes?prefix=${encodeURIComponent(prefix)}`);
    if (!response.ok) return [];
    return ((await response.json()) as { codes: string[] }).codes;
  } catch {
    return [];
  }
}

const CATEGORIES_KEY = "kassa.categories";

function keptCategories(): Category[] | null {
  try {
    const raw = localStorage.getItem(CATEGORIES_KEY);
    const parsed = raw ? (JSON.parse(raw) as Array<Partial<Category>>) : null;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item?.code === "string" && typeof item?.label === "string")) return null;
    // A copy kept by an older version has expense categories only, without what the owner can set on them.
    return parsed.map((item, index) => ({
      code: item.code!,
      label: item.label!,
      kind: item.kind ?? "expense",
      sortOrder: item.sortOrder ?? index + 1,
      archived: item.archived ?? false,
      requiresClient: item.requiresClient ?? item.code === "client_refund",
      countsAsCost: item.countsAsCost ?? item.code !== "owner_handover",
      notifyGroup: item.notifyGroup ?? true,
    }));
  } catch {
    return null;
  }
}

function keepCategories(categories: Category[]) {
  try {
    localStorage.setItem(CATEGORIES_KEY, JSON.stringify(categories));
  } catch {
    // not kept; the next visit with a connection tries again
  }
}

/**
 * Every category of incomes and expenses, archived ones too (the journal still names them); a form takes
 * `activeCategories` of its kind. The lists hardly ever change, so the last one seen is kept on the phone and
 * used when the server cannot be asked: an entry can be made without a connection.
 */
export async function fetchCategories(): Promise<Category[]> {
  try {
    const response = await request("/api/categories");
    if (response.status === 401) throw new SessionExpiredError("Session ended");
    if (!response.ok) throw new Error(`Unexpected status ${response.status} from /api/categories`);
    const categories = ((await response.json()) as { all: Category[] }).all;
    if (!Array.isArray(categories)) throw new Error("The answer of /api/categories is not the lists of categories");
    keepCategories(categories);
    return categories;
  } catch (error) {
    const kept = error instanceof SessionExpiredError ? null : keptCategories();
    if (kept) return kept;
    throw error;
  }
}

type EntryBase = {
  /** Made once per entry and kept across retries, so a retry can never count twice. */
  id: string;
  /** The shift that was open on this phone when the entry was made, so that an entry sent later still belongs to it. */
  shiftId?: string;
  amountMinor: number;
  currency: Currency;
  /** Rubles for one dollar, times 10 000. An income in rubles must have it, an expense in rubles may; never for dollars. */
  rateE4?: number;
  comment?: string;
};

export type OperationInput =
  | (EntryBase & {
      type: "income";
      /** A category of income. An entry made by an older version has none, and the server takes it for a payment of a client. */
      category?: string;
      /** Only for a category that names a client. */
      clientCode?: string;
    })
  | (EntryBase & {
      type: "expense";
      category: string;
      recipient?: string;
      /** Only for a category that names a client (a refund to a client, say). */
      clientCode?: string;
    });

export type OperationResult =
  | { ok: true; operation: Operation; balances: Balance[] }
  | {
      ok: false;
      reason:
        | "session-expired"
        /** The session belongs to another cashier than the one who made the entry. */
        | "wrong-session"
        | "forbidden"
        | "conflict"
        | "rejected"
        | "server-error";
    };

/** Answers that say "not now" and not "no": a proxy that is busy, a server that is being replaced. */
const TRY_AGAIN_LATER = new Set([404, 405, 408, 425, 429]);

/**
 * Sends an entry. `login` is whose entry it is: the server takes the author from the session, and
 * refuses the entry (409 wrong_session) when the session is another cashier's. Percent-encoded,
 * because a header cannot carry every alphabet and a login may be in any.
 */
export async function createOperation(input: OperationInput, login: string): Promise<OperationResult> {
  const response = await request(
    "/api/operations",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-kassa-as": encodeURIComponent(login) },
      body: JSON.stringify(input),
    },
    10_000,
  );
  if (response.ok) {
    // Only an answer that is about this entry counts as the server having it: anything else that says
    // 200 (a captive portal, a proxy of some kind) would otherwise make the phone forget the entry.
    const body = (await response.json().catch(() => null)) as { operation?: Operation; balances?: Balance[] } | null;
    if (body?.operation?.id !== input.id || !Array.isArray(body.balances)) return { ok: false, reason: "server-error" };
    return { ok: true, operation: body.operation, balances: body.balances };
  }
  if (response.status === 401) return { ok: false, reason: "session-expired" };
  if (response.status === 403) return { ok: false, reason: "forbidden" };
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, reason: body?.error === "wrong_session" ? "wrong-session" : "conflict" };
  }
  // The server itself failed, or is busy: the entry may or may not have been saved, which is not the
  // data's fault and must not be reported as if it were.
  if (response.status >= 500 || TRY_AGAIN_LATER.has(response.status)) return { ok: false, reason: "server-error" };
  return { ok: false, reason: "rejected" };
}

// ---- Journal ----

export type Cashier = { login: string; displayName: string };

export type JournalFilters = {
  /** Moscow calendar days, YYYY-MM-DD, both included. Left out when a shift is asked for. */
  from?: string;
  to?: string;
  currency?: Currency;
  type?: "income" | "expense";
  category?: string;
  clientCode?: string;
  author?: string;
  /** Viewer only: show deleted operations too, or only them. Left out, they are hidden. */
  deleted?: "include" | "only";
  /** The operations of the shift that is open now, whatever the day (no period is given with it). */
  shift?: "current";
};

export type JournalPage = { operations: Operation[]; nextCursor: string | null };

/** One page of the journal. Empty filters are left out; `cursor` asks for the page after a known one. */
export async function fetchJournal(filters: JournalFilters, cursor?: string): Promise<JournalPage> {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries({ ...filters, cursor })) {
    if (value) params.set(name, value);
  }
  const response = await request(`/api/operations?${params}`);
  if (response.status === 401) throw new SessionExpiredError("Session ended");
  if (!response.ok) throw new Error(`Unexpected status ${response.status} from /api/operations`);
  const body = (await response.json()) as JournalPage;
  return { operations: body.operations, nextCursor: body.nextCursor };
}

/** Cashiers for the viewer's filter. Never throws: the filter just has fewer choices. */
export async function fetchCashiers(): Promise<Cashier[]> {
  try {
    const response = await request("/api/cashiers");
    if (!response.ok) return [];
    return ((await response.json()) as { cashiers: Cashier[] }).cashiers;
  } catch {
    return [];
  }
}

// ---- Totals of a period (the viewer) ----

export type CurrencyTotals = {
  currency: Currency;
  /** The balance when the first day begins, and when the last day ends. */
  openingMinor: number;
  closingMinor: number;
  incomeMinor: number;
  /** Everything paid out except the money handed to the owner, and where it went. */
  expenseMinor: number;
  expenseByCategory: Array<{ category: string; amountMinor: number }>;
  handoverMinor: number;
  /** What counting the cash found at the end of the shifts closed in the period: a shortage is negative. */
  differenceMinor: number;
};

/** The period counted in dollars: dollars as they are, rubles at the rate of the entry (see `Operation.usdMinor`). */
export type DollarTotals = {
  incomeMinor: number;
  expenseMinor: number;
  handoverMinor: number;
  /** Income minus expense. */
  resultMinor: number;
  /** Ruble entries that have no rate to count them at, and are not in the figures above. */
  withoutRate: {
    income: { rubMinor: number; count: number };
    expense: { rubMinor: number; count: number };
  };
};

export type Totals = { from: string; to: string; currencies: CurrencyTotals[]; usd: DollarTotals };

/** The totals of a period (Moscow days, both included), each currency on its own. */
export async function fetchTotals(from: string, to: string): Promise<Totals> {
  const response = await request(`/api/summary?${new URLSearchParams({ from, to })}`);
  if (response.status === 401) throw new SessionExpiredError("Session ended");
  if (!response.ok) throw new Error(`Unexpected status ${response.status} from /api/summary`);
  const body = (await response.json()) as Totals;
  // An answer of another shape (a page of a proxy that said 200) is not totals: never show it as zeros.
  if (!Array.isArray(body.currencies) || typeof body.from !== "string" || typeof body.to !== "string" || !body.usd) {
    throw new Error("The answer of /api/summary is not the totals of a period");
  }
  return body;
}

// ---- Corrections and history ----

export type Snapshot = {
  amountMinor: number;
  currency: Currency;
  rateE4: number | null;
  category: string | null;
  recipient: string | null;
  clientCode: string | null;
  comment: string | null;
};

type EditBase = {
  amountMinor: number;
  currency: Currency;
  rateE4?: number;
  comment?: string;
  /** Why, in the person's words. Optional. */
  reason?: string;
};

/** What a correction sends: the whole of what the operation should say now. */
export type EditInput =
  | (EditBase & { type: "income"; category: string; clientCode?: string })
  | (EditBase & { type: "expense"; category: string; recipient?: string; clientCode?: string });

export type ChangeResult =
  | { ok: true; operation: Operation; balances: Balance[] }
  | { ok: false; reason: "session-expired" | "forbidden" | "not-found" | "deleted" | "rejected" | "server-error" };

async function changeResult(response: Response): Promise<ChangeResult> {
  if (response.ok) {
    const body = (await response.json()) as { operation: Operation; balances: Balance[] };
    return { ok: true, ...body };
  }
  if (response.status === 401) return { ok: false, reason: "session-expired" };
  if (response.status === 403) return { ok: false, reason: "forbidden" };
  if (response.status === 404) return { ok: false, reason: "not-found" };
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, reason: body?.error === "operation_deleted" ? "deleted" : "rejected" };
  }
  if (response.status >= 500) return { ok: false, reason: "server-error" };
  return { ok: false, reason: "rejected" };
}

/** Correct one of your own operations. Safe to send again: the same correction changes nothing twice. */
export async function editOperation(id: string, input: EditInput): Promise<ChangeResult> {
  return changeResult(
    await request(`/api/operations/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

/** Delete one of your own operations: it is hidden, never destroyed. Safe to send again. */
export async function deleteOperation(id: string, reason?: string): Promise<ChangeResult> {
  return changeResult(
    await request(`/api/operations/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reason ? { reason } : {}),
    }),
  );
}

export type HistoryChange = {
  revision: number;
  action: "edit" | "delete";
  at: string;
  by: { login: string; displayName: string };
  reason: string | null;
  before: Snapshot;
  after: Snapshot;
};

export type OperationHistory = {
  operation: Operation;
  created: { at: string; by: { login: string; displayName: string }; state: Snapshot };
  changes: HistoryChange[];
};

/** Everything that happened to an operation (viewer only). */
export async function fetchHistory(id: string): Promise<OperationHistory> {
  const response = await request(`/api/operations/${id}/history`);
  if (response.status === 401) throw new SessionExpiredError("Session ended");
  if (!response.ok) throw new Error(`Unexpected status ${response.status} from the history`);
  return (await response.json()) as OperationHistory;
}

// ---- Shifts ----

export type Shift = {
  id: string;
  /** ISO time. */
  openedAt: string;
  cashier: { login: string; displayName: string };
  /** What the shift started with, each currency. */
  openingBalances: Balance[];
};

function readShift(value: unknown): Shift | null {
  const shift = value as Partial<Shift> | null;
  if (
    !shift ||
    typeof shift.id !== "string" ||
    typeof shift.openedAt !== "string" ||
    typeof shift.cashier?.login !== "string" ||
    typeof shift.cashier.displayName !== "string" ||
    !Array.isArray(shift.openingBalances)
  ) {
    return null;
  }
  return shift as Shift;
}

/** The shift that is open now, or null when none is. Throws when the server cannot say. */
export async function fetchCurrentShift(): Promise<Shift | null> {
  const response = await request("/api/shifts/current");
  if (response.status === 401) throw new SessionExpiredError("Session ended");
  if (!response.ok) throw new Error(`Unexpected status ${response.status} from /api/shifts/current`);
  const body = (await response.json()) as { shift: unknown };
  if (body.shift === null) return null;
  const shift = readShift(body.shift);
  if (!shift) throw new Error("The answer about the shift is not a shift");
  return shift;
}

export type OpenShiftResult =
  | { ok: true; shift: Shift }
  /** A shift is open already (whose it is, in `shift`). */
  | { ok: false; reason: "already-open"; shift: Shift | null };

/** Opens a shift for the signed-in cashier. Throws when the server cannot be reached or says something unexpected. */
export async function openShift(): Promise<OpenShiftResult> {
  const response = await request("/api/shifts", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (response.status === 401) throw new SessionExpiredError("Session ended");
  if (response.status === 201) {
    const shift = readShift(((await response.json()) as { shift: unknown }).shift);
    if (!shift) throw new Error("The answer about the shift is not a shift");
    return { ok: true, shift };
  }
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as { shift?: unknown } | null;
    return { ok: false, reason: "already-open", shift: readShift(body?.shift ?? null) };
  }
  throw new Error(`Unexpected status ${response.status} from /api/shifts`);
}

/** A shift as the owner reads it: who worked, when, and how the count of the cash came out. */
export type ShiftReport = {
  /** The average rate of the shift's ruble incomes, times 10 000, fixed when it was closed; null while open or when there was none. */
  averageRateE4: number | null;
  id: string;
  openedAt: string;
  /** Null while the shift is open. */
  closedAt: string | null;
  cashier: { login: string; displayName: string };
  closedBy: { login: string; displayName: string } | null;
  currencies: Array<{
    currency: Currency;
    openingMinor: number;
    /** What the books said at the end of the shift, what was counted, and the difference (counted minus books); null while open. */
    calculatedMinor: number | null;
    actualMinor: number | null;
    differenceMinor: number | null;
  }>;
};

function readReport(value: unknown): ShiftReport | null {
  const report = value as Partial<ShiftReport> | null;
  if (!report || typeof report.id !== "string" || typeof report.openedAt !== "string" || !Array.isArray(report.currencies) || typeof report.cashier?.login !== "string") {
    return null;
  }
  return report as ShiftReport;
}

export type CloseShiftResult =
  | { ok: true; shift: ShiftReport }
  | { ok: false; reason: "not-yours" | "not-found" | "rejected" | "server-error" }
  /** It was closed before, with another count. */
  | { ok: false; reason: "already-closed"; shift: ShiftReport | null };

/** Closes a shift with the count of the cash, one amount per currency (what was counted, not what the books say). */
export async function closeShift(shiftId: string, counted: Balance[]): Promise<CloseShiftResult> {
  const response = await request(`/api/shifts/${encodeURIComponent(shiftId)}/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ counted }),
  });
  if (response.status === 401) throw new SessionExpiredError("Session ended");
  if (response.ok) {
    const shift = readReport(((await response.json().catch(() => null)) as { shift?: unknown } | null)?.shift ?? null);
    return shift ? { ok: true, shift } : { ok: false, reason: "server-error" };
  }
  if (response.status === 403) return { ok: false, reason: "not-yours" };
  if (response.status === 404) return { ok: false, reason: "not-found" };
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as { shift?: unknown } | null;
    return { ok: false, reason: "already-closed", shift: readReport(body?.shift ?? null) };
  }
  return { ok: false, reason: response.status >= 500 ? "server-error" : "rejected" };
}

export type ShiftsPage = { shifts: ShiftReport[]; nextBefore: string | null };

/** The shifts, newest first (the owner). `before` asks for the page after the one that ended there. */
export async function fetchShifts(before?: string): Promise<ShiftsPage> {
  const response = await request(`/api/shifts${before ? `?${new URLSearchParams({ before })}` : ""}`);
  if (response.status === 401) throw new SessionExpiredError("Session ended");
  if (!response.ok) throw new Error(`Unexpected status ${response.status} from /api/shifts`);
  const body = (await response.json()) as { shifts?: unknown[]; nextBefore?: unknown };
  const shifts = (body.shifts ?? []).map(readReport);
  if (!Array.isArray(body.shifts) || shifts.some((shift) => shift === null)) throw new Error("The answer of /api/shifts is not a list of shifts");
  return { shifts: shifts as ShiftReport[], nextBefore: typeof body.nextBefore === "string" ? body.nextBefore : null };
}

// ---- The owner's lists of categories ----

export type CategoryChangeResult =
  | { ok: true; all: Category[] }
  | { ok: false; reason: "session-expired" | "forbidden" | "not-found" | "exists" | "last-category" | "rejected" | "server-error" };

async function categoryChangeResult(response: Response): Promise<CategoryChangeResult> {
  if (response.ok) {
    const body = (await response.json()) as { all?: Category[] };
    return Array.isArray(body.all) ? { ok: true, all: body.all } : { ok: false, reason: "server-error" };
  }
  if (response.status === 401) return { ok: false, reason: "session-expired" };
  if (response.status === 403) return { ok: false, reason: "forbidden" };
  if (response.status === 404) return { ok: false, reason: "not-found" };
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, reason: body?.error === "last_category" ? "last-category" : "exists" };
  }
  if (response.status >= 500) return { ok: false, reason: "server-error" };
  return { ok: false, reason: "rejected" };
}

/** The owner adds a category at the end of its list. */
export async function createCategory(kind: CategoryKind, label: string, requiresClient: boolean, notifyGroup: boolean): Promise<CategoryChangeResult> {
  const response = await request("/api/admin/categories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, label, requiresClient, notifyGroup }),
  });
  return categoryChangeResult(response);
}

/** The owner renames a category, changes whether it names a client or the group is told of it, archives or brings it back, or moves it in its list. */
export async function changeCategory(
  code: string,
  change: { label?: string; requiresClient?: boolean; notifyGroup?: boolean; archived?: boolean; move?: "up" | "down" },
): Promise<CategoryChangeResult> {
  const response = await request(`/api/admin/categories/${encodeURIComponent(code)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(change),
  });
  return categoryChangeResult(response);
}
