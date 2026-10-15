/** A cashier enters entries; the head cashier also counts the cash ("Сверить кассу"); an admin enters and keeps the users and the lists; the viewer is the owner, who only looks. */
export type Role = "cashier" | "head_cashier" | "admin" | "viewer";

export type User = {
  login: string;
  displayName: string;
  role: Role;
  /** The city of the person, which is the cash desk they work in; none: both (they choose). */
  city?: Kassa | null;
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
import type { Kassa } from "./kassa";

export type Balance = { currency: Currency; amountMinor: number };

export type Operation = {
  id: string;
  type: "income" | "expense";
  /** The cash desk it belongs to (an older server says nothing: Moscow). */
  kassa?: Kassa;
  amountMinor: number;
  currency: Currency;
  /** Rubles for one dollar, times 10 000: the rate of a ruble entry. Null for dollars, and for a ruble expense without one. */
  rateE4: number | null;
  /** What the entry is in dollars, and by which rate: its own, or the average of the ruble incomes of its day (an expense without one). Null while there is no rate at all. */
  usdMinor: number | null;
  rateSource: "own" | "day" | null;
  /** Only expenses have a category. */
  category: string | null;
  recipient: string | null;
  clientCode: string | null;
  /** The number of the trip and the counterparty, where the category asks for them. */
  tripNumber?: number | null;
  counterparty?: string | null;
  employee?: string | null;
  comment: string | null;
  author: { login: string; displayName: string };
  createdAt: string;
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
  /** An entry of this category must say the number of the trip, and the counterparty. */
  requiresTrip: boolean;
  requiresCounterparty: boolean;
  /** An entry of this category must name the employee. */
  requiresEmployee: boolean;
  /** The city it belongs to, for the reports and 1C (the cashiers do not see it); null is everywhere. */
  city?: City | null;
  /** False when it is of another city than the person's: the entry forms do not show it. Absent means shown. */
  offered?: boolean;
  /** False for the money handed to the owner: it is not a cost of the business. */
  countsAsCost: boolean;
  /** The Telegram group is told of the entries of this category. */
  notifyGroup: boolean;
};

/** The categories of one kind that a new entry may have, in the order of the owner's list. */
export function activeCategories(all: readonly Category[], kind: CategoryKind): Category[] {
  return all.filter((item) => item.kind === kind && !item.archived && item.offered !== false);
}

/** The income category that an entry without a category is: what the entries of before there were categories are. */
export const DEFAULT_INCOME_CATEGORY = "client_payment";

/** What to call an operation: an expense by its category, an income by its category too unless it is a payment of a client ("Приход"). */
export function operationTitle(type: "income" | "expense", category: string | null, labels: ReadonlyMap<string, string>): string {
  if (type === "expense") return labels.get(category ?? "") ?? "Расход";
  return category !== null && category !== DEFAULT_INCOME_CATEGORY ? (labels.get(category) ?? "Приход") : "Приход";
}

export async function fetchBalances(kassa?: Kassa): Promise<Balance[]> {
  const response = await request(kassa ? `/api/balances?${new URLSearchParams({ kassa })}` : "/api/balances");
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
      requiresTrip: item.requiresTrip ?? false,
      requiresCounterparty: item.requiresCounterparty ?? false,
      requiresEmployee: item.requiresEmployee ?? false,
      countsAsCost: item.countsAsCost ?? item.code !== "owner_handover",
      notifyGroup: item.notifyGroup ?? true,
      ...(item.city !== undefined && { city: item.city }),
      ...(item.offered !== undefined && { offered: item.offered }),
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
  /** The cash desk it goes to; an entry of an older version has none, and goes to the desk of its cashier. */
  kassa?: Kassa;
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
      /** Only for a category that asks for them. */
      tripNumber?: number;
      counterparty?: string;
      employee?: string;
    })
  | (EntryBase & {
      type: "expense";
      category: string;
      recipient?: string;
      /** Only for a category that names a client (a refund to a client, say). */
      clientCode?: string;
      tripNumber?: number;
      counterparty?: string;
      employee?: string;
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
  /** Days of the cash desk (03:00 to 03:00 Moscow time), YYYY-MM-DD, both included. */
  from?: string;
  to?: string;
  currency?: Currency;
  type?: "income" | "expense";
  category?: string;
  clientCode?: string;
  author?: string;
  /** One cash desk; left out, the person's own, or both for a person of everywhere. */
  kassa?: Kassa;
  /** Viewer only: show deleted operations too, or only them. Left out, they are hidden. */
  deleted?: "include" | "only";
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
  /** What the counts of the cash made in the period found: a shortage is negative. */
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
export async function fetchTotals(from: string, to: string, kassa?: Kassa): Promise<Totals> {
  const response = await request(`/api/summary?${new URLSearchParams({ from, to, ...(kassa ? { kassa } : {}) })}`);
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
  /** Missing in the history of before there were trips and counterparties. */
  tripNumber?: number | null;
  counterparty?: string | null;
  employee?: string | null;
  comment: string | null;
};

type EditBase = {
  amountMinor: number;
  currency: Currency;
  rateE4?: number;
  tripNumber?: number;
  counterparty?: string;
  employee?: string;
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
  | { ok: false; reason: "session-expired" | "forbidden" | "too-late" | "not-found" | "deleted" | "rejected" | "server-error" };

async function changeResult(response: Response): Promise<ChangeResult> {
  if (response.ok) {
    const body = (await response.json()) as { operation: Operation; balances: Balance[] };
    return { ok: true, ...body };
  }
  if (response.status === 401) return { ok: false, reason: "session-expired" };
  if (response.status === 403) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, reason: body?.error === "change_window_closed" ? "too-late" : "forbidden" };
  }
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

// ---- Counting the cash ----

/** A count of the cash as it is read: who made it, when, and per currency what the book said, what was counted, the difference. */
export type Reconciliation = {
  id: string;
  /** The cash desk that was counted (an older server says nothing: Moscow). */
  kassa?: Kassa;
  madeAt: string;
  madeBy: { login: string; displayName: string };
  currencies: Array<{
    currency: Currency;
    /** What the book said at that moment, what was counted in the cash desk, and the difference (counted minus book: a shortage is negative). */
    calculatedMinor: number;
    actualMinor: number;
    differenceMinor: number;
  }>;
  /** The part of the rubles counted that lay on the cards (the rubles counted include it). Null for the counts of before. */
  cardMinor?: number | null;
};

function readReconciliation(value: unknown): Reconciliation | null {
  const report = value as Partial<Reconciliation> | null;
  if (!report || typeof report.id !== "string" || typeof report.madeAt !== "string" || !Array.isArray(report.currencies) || typeof report.madeBy?.login !== "string") {
    return null;
  }
  return report as Reconciliation;
}

export type ReconcileResult =
  | { ok: true; reconciliation: Reconciliation; balances: Balance[] }
  /** `rejected`: the sums were not accepted; `server-error`: the server did not manage, and sending the same count again counts once. */
  | { ok: false; reason: "forbidden" | "id-conflict" | "rejected" | "server-error" };

/**
 * The admin counts the cash: one amount per currency (what was counted, not what the book says). The id is made once per
 * count and kept across retries, so that a lost answer cannot make the count twice. Throws when the server cannot be reached.
 */
export async function reconcileCash(id: string, counted: Balance[], cardMinor: number | undefined, kassa?: Kassa): Promise<ReconcileResult> {
  const response = await request("/api/reconciliations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, counted, cardMinor, kassa }),
  });
  if (response.status === 401) throw new SessionExpiredError("Session ended");
  if (response.ok) {
    const body = (await response.json().catch(() => null)) as { reconciliation?: unknown; balances?: unknown } | null;
    const reconciliation = readReconciliation(body?.reconciliation ?? null);
    return reconciliation && Array.isArray(body?.balances) ? { ok: true, reconciliation, balances: body.balances as Balance[] } : { ok: false, reason: "server-error" };
  }
  if (response.status === 403) return { ok: false, reason: "forbidden" };
  if (response.status === 409) return { ok: false, reason: "id-conflict" };
  return { ok: false, reason: response.status >= 500 ? "server-error" : "rejected" };
}

export type ReconciliationsPage = { reconciliations: Reconciliation[]; nextBefore: string | null };

/** The counts of the cash, newest first (the owner and the admin). `before` asks for the page after the one that ended there. */
export async function fetchReconciliations(before?: string, kassa?: Kassa): Promise<ReconciliationsPage> {
  const query = new URLSearchParams({ ...(before ? { before } : {}), ...(kassa ? { kassa } : {}) });
  const response = await request(`/api/reconciliations${query.toString() ? `?${query}` : ""}`);
  if (response.status === 401) throw new SessionExpiredError("Session ended");
  if (!response.ok) throw new Error(`Unexpected status ${response.status} from /api/reconciliations`);
  const body = (await response.json()) as { reconciliations?: unknown[]; nextBefore?: unknown };
  const reconciliations = (body.reconciliations ?? []).map(readReconciliation);
  if (!Array.isArray(body.reconciliations) || reconciliations.some((item) => item === null)) {
    throw new Error("The answer of /api/reconciliations is not a list of counts");
  }
  return { reconciliations: reconciliations as Reconciliation[], nextBefore: typeof body.nextBefore === "string" ? body.nextBefore : null };
}

// ---- The owner's lists of categories ----

export type CategoryChangeResult =
  | { ok: true; all: Category[] }
  | { ok: false; reason: "session-expired" | "forbidden" | "not-found" | "exists" | "last-category" | "category-used" | "kind-locked" | "rejected" | "server-error" };

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
    const known = { last_category: "last-category", category_used: "category-used", kind_locked: "kind-locked" } as const;
    return { ok: false, reason: known[body?.error as keyof typeof known] ?? "exists" };
  }
  if (response.status >= 500) return { ok: false, reason: "server-error" };
  return { ok: false, reason: "rejected" };
}

/** The owner adds a category at the end of its list. */
/** The cities a category or a person can belong to; none means everywhere. */
export type City = "andijan" | "moscow";

export const CITY_LABEL: Record<City, string> = { andijan: "Андижан", moscow: "Москва" };

export type CategoryFlags = { requiresClient: boolean; requiresTrip: boolean; requiresCounterparty: boolean; requiresEmployee: boolean; notifyGroup: boolean; city?: City | null };

export async function createCategory(kind: CategoryKind, label: string, flags: CategoryFlags): Promise<CategoryChangeResult> {
  const response = await request("/api/admin/categories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, label, ...flags }),
  });
  return categoryChangeResult(response);
}

/** The owner renames a category, changes whether it names a client or the group is told of it, archives or brings it back, or moves it in its list. */
export async function changeCategory(
  code: string,
  change: { label?: string; requiresClient?: boolean; requiresTrip?: boolean; requiresCounterparty?: boolean; requiresEmployee?: boolean; notifyGroup?: boolean; archived?: boolean; move?: "up" | "down"; position?: number; kind?: CategoryKind; city?: City | null },
): Promise<CategoryChangeResult> {
  const response = await request(`/api/admin/categories/${encodeURIComponent(code)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(change),
  });
  return categoryChangeResult(response);
}

// ---- The admin's accounts ----

export type Account = {
  id: string;
  login: string;
  displayName: string;
  role: Role;
  /** The city the person works in, for the reports and 1C; null is everywhere. */
  city?: City | null;
  active: boolean;
  createdAt: string;
  /** The person wrote, changed or counted something: the account stays, it can only be blocked. */
  hasEntries: boolean;
};

export type AccountResult =
  | { ok: true }
  | {
      ok: false;
      reason: "session-expired" | "forbidden" | "not-found" | "login-taken" | "bad-login" | "bad-password" | "bad-name" | "self" | "has-entries" | "rejected" | "server-error";
    };

async function accountResult(response: Response): Promise<AccountResult> {
  if (response.ok) return { ok: true };
  if (response.status === 401) return { ok: false, reason: "session-expired" };
  if (response.status === 403) return { ok: false, reason: "forbidden" };
  if (response.status === 404) return { ok: false, reason: "not-found" };
  if (response.status >= 500) return { ok: false, reason: "server-error" };
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  const known: Record<string, Extract<AccountResult, { ok: false }>["reason"]> = {
    login_taken: "login-taken",
    bad_login: "bad-login",
    bad_password: "bad-password",
    bad_name: "bad-name",
    self: "self",
    has_entries: "has-entries",
  };
  return { ok: false, reason: known[body?.error ?? ""] ?? "rejected" };
}

export async function fetchAccounts(): Promise<Account[]> {
  const response = await request("/api/admin/users");
  if (response.status === 401) throw new SessionExpiredError("Session ended");
  if (!response.ok) throw new Error(`Unexpected status ${response.status} from /api/admin/users`);
  const users = ((await response.json()) as { users: Account[] }).users;
  if (!Array.isArray(users)) throw new Error("The answer of /api/admin/users is not a list of accounts");
  return users;
}

export async function createAccount(input: { login: string; displayName?: string; password: string; role: Role; city?: City | null }): Promise<AccountResult> {
  const response = await request("/api/admin/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return accountResult(response);
}

export async function changeAccount(
  id: string,
  change: { login?: string; displayName?: string; role?: Role; password?: string; active?: boolean; city?: City | null },
): Promise<AccountResult> {
  const response = await request(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(change),
  });
  return accountResult(response);
}

export async function deleteAccount(id: string): Promise<AccountResult> {
  const response = await request(`/api/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" });
  return accountResult(response);
}
