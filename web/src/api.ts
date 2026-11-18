/**
 * A cashier enters entries; the head cashier also counts the cash ("Сверить кассу"); an admin enters and keeps the users
 * and the lists; the viewer is the owner, who only looks; the keeper of a warehouse writes the cargo of the trips
 * (where the business keeps trips) and sees nothing of the cash.
 */
export type Role = "cashier" | "head_cashier" | "admin" | "viewer" | "warehouse";

/** The roles that make entries of the cash desk: theirs is the queue of the phone, the balances, the lists of categories. */
export const entersCash = (role: Role) => role === "cashier" || role === "head_cashier" || role === "admin";

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
import { DEFAULT_KASSAS, type Kassa, type KassaInfo } from "./kassa";

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
  /** The admin's journal only: what became of the entry in 1C; null when it never went into the queue of 1C. */
  onec?: OneCState | null;
};

/**
 * A payment of a client in the queue of 1C. pending: waits for its turn; written: the document is in 1C; blocked: waits
 * for a person (no such client in 1C, no contract...), tried again every quarter of an hour; failed: given up; skipped:
 * not to be written; preview: only rehearsed; removed: the entry was deleted, its document unposted and marked for deletion.
 */
export type OneCStatus = "pending" | "written" | "blocked" | "failed" | "skipped" | "preview" | "removed";
export type OneCState = {
  id: number;
  status: OneCStatus;
  docNumber: string | null;
  detail: string | null;
  attempts: number;
  /** When it is tried next: what was entered or changed today goes at 03:00 Moscow time, when the day is over. */
  nextAttemptAt?: string | null;
};

/** The admin's filter on the column «1С». */
export type OneCFilter = "written" | "waiting" | "problem" | "none";

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
  /**
   * The cash desk the money of an entry of this category goes into, whoever enters it (a payment the owner took in
   * Tashkent, written down in Moscow); null or absent: the desk of the person.
   */
  intoKassa?: City | null;
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

const KASSAS_KEY = "kassa.kassas";

/** The cash desks out of an answer of the server or out of what the phone kept; null when it is not a list of desks. */
function readKassas(value: unknown): KassaInfo[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const list: KassaInfo[] = [];
  for (const item of value as Array<Partial<KassaInfo> | null>) {
    if (!item || typeof item.id !== "string" || item.id === "" || typeof item.label !== "string" || !Array.isArray(item.currencies)) return null;
    const currencies = (["RUB", "USD"] as const).filter((code) => (item.currencies as readonly string[]).includes(code));
    if (currencies.length === 0) return null;
    list.push({
      id: item.id,
      label: item.label,
      short: typeof item.short === "string" && item.short !== "" ? item.short : item.label.slice(0, 3).toUpperCase(),
      currencies,
      onec: item.onec === true,
    });
  }
  return list;
}

/** The cash desks as the server named them last, kept on the phone; null when it never did. */
export function keptKassas(): KassaInfo[] | null {
  try {
    const raw = localStorage.getItem(KASSAS_KEY);
    return raw ? readKassas(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/**
 * The cash desks of the business: which there are, what each is called and what money it keeps is the server's to say
 * (the settings of its installation). The last answer is kept on the phone, for opening the app without a connection.
 * A server that does not know the question (an older version) has the two desks there were then. Never throws:
 * `fresh` says whether the server answered now; when it did not, the desks are the ones kept, or those two.
 */
export async function fetchKassas(): Promise<{ kassas: readonly KassaInfo[]; fresh: boolean }> {
  try {
    const response = await request("/api/kassas", undefined, 5_000);
    if (response.status === 404) {
      // What a newer version left on the phone is not this server's.
      try {
        localStorage.removeItem(KASSAS_KEY);
      } catch {
        // nothing to do
      }
      return { kassas: DEFAULT_KASSAS, fresh: true };
    }
    if (response.ok) {
      const kassas = readKassas(((await response.json()) as { kassas?: unknown }).kassas);
      if (kassas) {
        try {
          localStorage.setItem(KASSAS_KEY, JSON.stringify(kassas));
        } catch {
          // not kept; the next visit with a connection asks again
        }
        return { kassas, fresh: true };
      }
    }
  } catch {
    // no connection: what the phone kept
  }
  return { kassas: keptKassas() ?? DEFAULT_KASSAS, fresh: false };
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
      ...(item.intoKassa !== undefined && { intoKassa: item.intoKassa }),
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
        /** The client code is not one of the directory. */
        | "unknown-client"
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
  if (response.status === 400) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    if (body?.error === "unknown_client") return { ok: false, reason: "unknown-client" };
  }
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
  /** Admin only: what became of the entries in 1C. */
  onec?: OneCFilter;
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
/** The city a category or a person belongs to, which is the id of a cash desk; none means everywhere. */
export type City = Kassa;

export type CategoryFlags = { requiresClient: boolean; requiresTrip: boolean; requiresCounterparty: boolean; requiresEmployee: boolean; notifyGroup: boolean; city?: City | null; intoKassa?: City | null };

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
  change: { label?: string; requiresClient?: boolean; requiresTrip?: boolean; requiresCounterparty?: boolean; requiresEmployee?: boolean; notifyGroup?: boolean; archived?: boolean; move?: "up" | "down"; position?: number; kind?: CategoryKind; city?: City | null; intoKassa?: City | null },
): Promise<CategoryChangeResult> {
  const response = await request(`/api/admin/categories/${encodeURIComponent(code)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(change),
  });
  return categoryChangeResult(response);
}

// ---- The admin's buttons in the column «1С» ----

export type OneCActionResult = { ok: true } | { ok: false; reason: "wrong-state" | "not-found" | "failed" };

/** «Повторить» (back in the queue) or «Не записывать» (given up) on a payment in the column «1С». Nothing in 1C is changed by it. */
export async function changeOneC(id: number, action: "retry" | "skip"): Promise<OneCActionResult> {
  const response = await request(`/api/admin/onec/${id}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (response.status === 401) throw new SessionExpiredError("Session ended");
  if (response.ok) return { ok: true };
  if (response.status === 409) return { ok: false, reason: "wrong-state" };
  if (response.status === 404) return { ok: false, reason: "not-found" };
  return { ok: false, reason: "failed" };
}

// ---- The admin's accounts ----

export type Account = {
  id: string;
  login: string;
  displayName: string;
  role: Role;
  /** The city the person works in, for the reports and 1C; null is everywhere. Of the keeper of a warehouse, the warehouse. */
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
      reason: "session-expired" | "forbidden" | "not-found" | "login-taken" | "bad-login" | "bad-password" | "bad-name" | "bad-city" | "self" | "has-entries" | "rejected" | "server-error";
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
    bad_city: "bad-city",
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

// ---- Clients ----

/**
 * A client of the directory: one to a code (А707, А34-2); the names may repeat. Where the business keeps trips, the
 * directory also says what a kilogram costs the client (thousandths of a dollar) and what they owe, in cents: what
 * they owed at the start, plus their cargo on the trips that have arrived, less what the cash desk took in from them.
 */
export type Client = {
  code: string;
  name: string;
  phone: string | null;
  note: string | null;
  active: boolean;
  priceMilli?: number | null;
  openingDebtMinor?: number;
  chargedMinor?: number;
  paidMinor?: number;
  /** More than nothing: the client owes; less: they have paid ahead. Not there where the business keeps no trips. */
  debtMinor?: number;
  /** The day of the last payment and the day the last truck with their cargo came; null: never. */
  lastPaidDay?: string | null;
  lastTripDay?: string | null;
  /** For how many days the client has not paid (since the history began, with no payment at all). */
  daysUnpaid?: number;
};

/** How the business writes the codes of its clients: the letter А and digits («А707»), or digits alone («707»). */
export type ClientCodes = "letter" | "digits";

/** How an entry names a client: "А707 Карим", or the code alone. */
export const clientLabel = (client: Pick<Client, "code" | "name">) => (client.name ? `${client.code} ${client.name}` : client.code);

/**
 * The clients whose code starts with `q`, then those whose name has it; all of them without `q` (the list of
 * «Управление»), switched off ones too with `all`.
 */
export async function fetchClients(q = "", options: { all?: boolean; limit?: number } = {}): Promise<Client[]> {
  return (await fetchClientDirectory(q, options)).clients;
}

/** The same, with how a code is written in this business (a server that does not say writes «А707»). */
export async function fetchClientDirectory(q = "", options: { all?: boolean; limit?: number } = {}): Promise<{ clients: Client[]; codes: ClientCodes }> {
  const query = new URLSearchParams({ ...(q ? { q } : {}), ...(options.all ? { all: "1" } : {}), ...(options.limit ? { limit: String(options.limit) } : {}) });
  const response = await request(`/api/clients${query.toString() ? `?${query}` : ""}`);
  if (response.status === 401) throw new SessionExpiredError("Session ended");
  if (!response.ok) throw new Error(`Unexpected status ${response.status} from /api/clients`);
  const body = (await response.json()) as { clients: Client[]; codes?: string };
  return { clients: body.clients, codes: body.codes === "digits" ? "digits" : "letter" };
}

export type ClientResult =
  | { ok: true; client?: Client }
  | { ok: false; reason: "session-expired" | "forbidden" | "not-found" | "exists" | "bad-code" | "bad-name" | "rejected" | "server-error" };

async function clientResult(response: Response): Promise<ClientResult> {
  if (response.ok) {
    const body = (await response.json().catch(() => null)) as { client?: Client } | null;
    return { ok: true, client: body?.client };
  }
  if (response.status === 401) return { ok: false, reason: "session-expired" };
  if (response.status === 403) return { ok: false, reason: "forbidden" };
  if (response.status === 404) return { ok: false, reason: "not-found" };
  if (response.status >= 500) return { ok: false, reason: "server-error" };
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (body?.error === "client_exists") return { ok: false, reason: "exists" };
  if (body?.error === "bad_code") return { ok: false, reason: "bad-code" };
  if (body?.error === "bad_name") return { ok: false, reason: "bad-name" };
  return { ok: false, reason: "rejected" };
}

/** A new client (the admin, in «Клиенты»). */
export async function createClient(input: { code: string; name: string; phone?: string; note?: string; priceMilli?: number | null; openingDebtMinor?: number }): Promise<ClientResult> {
  const response = await request("/api/admin/clients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return clientResult(response);
}

/** The admin changes a client's name, phone, note, or switches them off. The code never changes. */
export async function changeClient(
  code: string,
  change: { name?: string; phone?: string | null; note?: string | null; active?: boolean; priceMilli?: number | null; openingDebtMinor?: number },
): Promise<ClientResult> {
  const response = await request(`/api/admin/clients/${encodeURIComponent(code)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(change),
  });
  return clientResult(response);
}

export type ImportResult =
  | { ok: true; added: number; skipped: number }
  | {
      ok: false;
      reason: "session-expired" | "forbidden" | "server-error" | "rejected";
      repeated?: Array<{ code: string; lines: number[] }>;
      bad?: Array<{ line: number; code: string }>;
      /** The lines of the list that have a code and no name: a client is both. */
      nameless?: Array<{ line: number; code: string }>;
    };

/** A whole list at once: new codes are added, codes already there are left alone. A code twice: nothing is loaded. */
export async function importClients(clients: Array<{ code: string; name: string; phone?: string; priceMilli?: number; openingDebtMinor?: number }>): Promise<ImportResult> {
  const response = await request("/api/admin/clients/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clients }),
  }, 60_000);
  if (response.ok) return { ok: true, ...((await response.json()) as { added: number; skipped: number }) };
  if (response.status === 401) return { ok: false, reason: "session-expired" };
  if (response.status === 403) return { ok: false, reason: "forbidden" };
  if (response.status >= 500) return { ok: false, reason: "server-error" };
  const body = (await response.json().catch(() => null)) as { error?: string; codes?: Array<{ code: string; lines: number[] }>; rows?: Array<{ line: number; code: string }> } | null;
  if (body?.error === "nameless") return { ok: false, reason: "rejected", nameless: body.rows };
  return { ok: false, reason: "rejected", repeated: body?.codes, bad: body?.rows };
}

// ---- Groupage: the warehouses, the trips and the cargo on them ----

import type { TripStatus } from "./cargo";

/** A warehouse where cargo is put on the trucks, as the server names it (the settings of its installation). */
export type Warehouse = { id: string; label: string };

const WAREHOUSES_KEY = "kassa.warehouses";

function readWarehouses(value: unknown): Warehouse[] | null {
  if (!Array.isArray(value)) return null;
  const list: Warehouse[] = [];
  for (const item of value as Array<Record<string, unknown>>) {
    if (typeof item?.id !== "string" || typeof item.label !== "string") return null;
    list.push({ id: item.id, label: item.label });
  }
  return list;
}

/**
 * The warehouses of the business: with none it keeps no trips, and the app has no section «Сборные грузы». The last
 * answer is kept on the phone, so that the menu is the same at once on the next visit. Never throws: a server that
 * does not know the question (an older version) has none, and without a connection the ones kept are used.
 */
export async function fetchWarehouses(): Promise<Warehouse[]> {
  try {
    const response = await request("/api/warehouses", undefined, 5_000);
    const warehouses = response.ok ? readWarehouses(((await response.json()) as { warehouses?: unknown }).warehouses) : response.status === 404 ? [] : null;
    if (warehouses) {
      try {
        localStorage.setItem(WAREHOUSES_KEY, JSON.stringify(warehouses));
      } catch {
        // not kept; the next visit asks again
      }
      return warehouses;
    }
  } catch {
    // no connection: what the phone kept
  }
  try {
    return readWarehouses(JSON.parse(localStorage.getItem(WAREHOUSES_KEY) ?? "null")) ?? [];
  } catch {
    return [];
  }
}

/** A trip: a truck, and what is on it. Days are YYYY-MM-DD, the weight is grams, the money cents of a dollar. */
export type Trip = {
  number: number;
  driverName: string | null;
  driverPhone: string | null;
  truckPlates: string | null;
  note: string | null;
  /** Where it goes: «АНДИЖОН - МОСКВА (через КЗХ)». */
  direction: string | null;
  /** The day it was loaded; it leaves (`departureDay`) a day or two later. */
  loadingDay: string | null;
  departureDay: string | null;
  arrivalDay: string | null;
  status: TripStatus;
  /** A trip of the history, taken over from the card file: no waybill, only what each client owed for it. */
  fromCardFile?: boolean;
  lines: number;
  bags: number;
  weightG: number;
  amountMinor: number;
};

/** A line of the waybill of a trip: the goods of one client, put on at one warehouse. */
export type TruckPart = "head" | "trailer";

export type CargoLine = {
  id: string;
  warehouse: string;
  /** Where on the truck it lies: the head (the front part) or the trailer; and its turn there («Голова 3»). */
  truckPart: TruckPart | null;
  place: number | null;
  /** The day the warehouse took it in. */
  acceptedDay: string | null;
  clientCode: string;
  clientName: string;
  /** Who receives it, by name: most often the client, sometimes somebody else under the client's code. */
  receiver: string | null;
  sender: string | null;
  receiverPhone: string | null;
  item: string | null;
  brand: string | null;
  size: string | null;
  bags: number | null;
  perBag: number | null;
  /** What it is packed in: «пэ меш», «коробка». */
  packaging: string | null;
  pieces: number | null;
  weightG: number;
  /** The price of a kilogram, thousandths of a dollar. */
  priceMilli: number;
  amountMinor: number;
  note: string | null;
  createdAt: string;
  author: string;
  /** The person who is signed in may correct the line and take it off. */
  mine: boolean;
};

export type TripDetail = {
  trip: Trip;
  cargo: CargoLine[];
  /** What each client has on the truck, and what they owe in all (the cash book counted in). */
  clients: Array<{ code: string; name: string; bags: number; weightG: number; amountMinor: number; debtMinor: number }>;
  /** The places on the head and on the trailer, as the foot of the waybill says them. */
  places?: { head: number; trailer: number };
  /** What the person who is signed in may do with this trip. */
  may: { edit: boolean; warehouses: string[]; forward: TripStatus | null; back: TripStatus | null; admin: boolean; remove: boolean };
  /** For the owner and the admin: what the cash desk spent on the trip, and what is left of its cargo after that. */
  money?: { expenseMinor: number; profitMinor: number };
};

export type TripsPage = { trips: Trip[]; nextBefore: number | null; nextNumber: number; mayCreate: boolean };

/** The trips, the newest number first. */
export async function fetchTrips(before?: number): Promise<TripsPage> {
  const response = await request(before === undefined ? "/api/trips" : `/api/trips?${new URLSearchParams({ before: String(before) })}`);
  if (response.status === 401) throw new SessionExpiredError("Session ended");
  if (!response.ok) throw new Error(`Unexpected status ${response.status} from /api/trips`);
  return (await response.json()) as TripsPage;
}

/** One trip with its waybill; null when there is no such trip (any more). */
export async function fetchTrip(number: number): Promise<TripDetail | null> {
  const response = await request(`/api/trips/${number}`);
  if (response.status === 401) throw new SessionExpiredError("Session ended");
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Unexpected status ${response.status} from /api/trips/${number}`);
  return (await response.json()) as TripDetail;
}

export type TripRefusal =
  | "session-expired"
  | "forbidden"
  | "not-found"
  /** Another trip has this number. */
  | "trip-exists"
  /** The truck has arrived: its waybill is closed to the keepers of the warehouses. */
  | "trip-arrived"
  | "trip-has-cargo"
  | "wrong-status"
  | "arrival-before-departure"
  | "unknown-client"
  /** The client has no price of their own, and the line says none. */
  | "price-required"
  | "warehouse-forbidden"
  | "rejected"
  | "server-error";

/** What a change of a trip answers: the trip as it is afterwards (none when it was taken away), or why not. */
export type TripResult = { ok: true; detail: TripDetail | null } | { ok: false; reason: TripRefusal };

const TRIP_REFUSALS: Record<string, TripRefusal> = {
  trip_exists: "trip-exists",
  trip_arrived: "trip-arrived",
  trip_has_cargo: "trip-has-cargo",
  wrong_status: "wrong-status",
  not_arrived: "wrong-status",
  arrival_before_departure: "arrival-before-departure",
  unknown_client: "unknown-client",
  price_required: "price-required",
  warehouse_forbidden: "warehouse-forbidden",
  cargo_id_conflict: "rejected",
  trip_from_card_file: "trip-arrived",
};

async function tripResult(response: Response): Promise<TripResult> {
  const body = (await response.json().catch(() => null)) as (Partial<TripDetail> & { error?: string; deleted?: boolean }) | null;
  if (response.ok) return { ok: true, detail: body?.trip ? (body as TripDetail) : null };
  if (response.status === 401) return { ok: false, reason: "session-expired" };
  if (response.status >= 500) return { ok: false, reason: "server-error" };
  const known = body?.error ? TRIP_REFUSALS[body.error] : undefined;
  if (known) return { ok: false, reason: known };
  if (response.status === 403) return { ok: false, reason: "forbidden" };
  if (response.status === 404) return { ok: false, reason: "not-found" };
  return { ok: false, reason: "rejected" };
}

const sendJson = (path: string, method: string, body?: unknown) =>
  request(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });

/** What the header of a trip says: who drives which truck, and when it left. */
export type TripHeader = {
  driverName?: string | null;
  driverPhone?: string | null;
  truckPlates?: string | null;
  note?: string | null;
  direction?: string | null;
  loadingDay?: string | null;
  departureDay?: string | null;
};

export const createTrip = async (input: TripHeader & { number: number }) => tripResult(await sendJson("/api/trips", "POST", input));

/** The header of a trip; its number and the day it arrived are the admin's to put right. */
export const changeTrip = async (number: number, change: TripHeader & { number?: number; arrivalDay?: string }) =>
  tripResult(await sendJson(`/api/trips/${number}`, "PATCH", change));

/** The truck left, the truck arrived (on `arrivalDay`: from then on its cargo is owed), or a step back by the admin. */
export const setTripStatus = async (number: number, status: TripStatus, arrivalDay?: string) =>
  tripResult(await sendJson(`/api/trips/${number}/status`, "POST", { status, ...(arrivalDay ? { arrivalDay } : {}) }));

export const deleteTrip = async (number: number) => tripResult(await sendJson(`/api/trips/${number}`, "DELETE"));

/** What a line of cargo says. Without a price, the client's own. */
export type CargoInput = {
  warehouse: string;
  truckPart?: TruckPart | null;
  acceptedDay?: string | null;
  clientCode: string;
  receiver?: string | null;
  sender?: string | null;
  receiverPhone?: string | null;
  item?: string | null;
  brand?: string | null;
  size?: string | null;
  bags?: number | null;
  perBag?: number | null;
  packaging?: string | null;
  pieces?: number | null;
  weightG: number;
  priceMilli?: number;
  note?: string | null;
};

/** A line onto the waybill. `id` is made here, so that a line sent twice is stored once. */
export const addCargo = async (number: number, id: string, input: CargoInput) => tripResult(await sendJson(`/api/trips/${number}/cargo`, "POST", { id, ...input }));

export const changeCargo = async (number: number, id: string, input: CargoInput) => tripResult(await sendJson(`/api/trips/${number}/cargo/${id}`, "PUT", input));

export const deleteCargo = async (number: number, id: string) => tripResult(await sendJson(`/api/trips/${number}/cargo/${id}`, "DELETE"));

// ---- The card of a client, and the control sheet of a year ----

/** One line of the card of a client: a trip that arrived, a payment, or money given back to the client. */
export type Movement = {
  day: string;
  kind: "trip" | "payment" | "refund";
  tripNumber: number | null;
  amountMinor: number;
  /** The cash desk that took a payment, where it is known. */
  kassa: string | null;
  /** A payment of before the cash book was kept here (taken over from the card file). */
  past: boolean;
  note: string | null;
  /** The debt after this line. */
  debtMinor: number;
};

export type ClientStatement = { code: string; name: string; openingDebtMinor: number; movements: Movement[]; debtMinor: number };

/** Everything behind the debt of one client, oldest first; null when there is no such client. */
export async function fetchClientStatement(code: string): Promise<ClientStatement | null> {
  const response = await request(`/api/clients/${encodeURIComponent(code)}/statement`);
  if (response.status === 401) throw new SessionExpiredError("Session ended");
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Unexpected status ${response.status} from the statement of a client`);
  return (await response.json()) as ClientStatement;
}

/** The card of a client as a workbook of Excel. */
export async function fetchClientSheet(code: string): Promise<Blob> {
  const response = await request(`/api/clients/${encodeURIComponent(code)}/statement.xlsx`, undefined, 30_000);
  if (response.status === 401) throw new SessionExpiredError("Session ended");
  if (!response.ok) throw new Error(`Unexpected status ${response.status} from the workbook of a client`);
  return response.blob();
}

/** A month of the control sheet: what all the clients owed when it began, what arrived, what was paid, what they owed when it ended. */
export type ControlMonth = { month: string; openingMinor: number; chargedMinor: number; paidMinor: number; closingMinor: number };

/** The control sheet of a year (the one that is running, unless said), month by month. */
export async function fetchDebtControl(year?: number): Promise<{ year: number; months: ControlMonth[] }> {
  const response = await request(year === undefined ? "/api/debts/control" : `/api/debts/control?${new URLSearchParams({ year: String(year) })}`);
  if (response.status === 401) throw new SessionExpiredError("Session ended");
  if (!response.ok) throw new Error(`Unexpected status ${response.status} from /api/debts/control`);
  return (await response.json()) as { year: number; months: ControlMonth[] };
}

export type Named = { code: string; name: string };

/** A line of the thirty who owe most. */
export type DebtTopRow = Named & {
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

/** A line of those who have not paid for long. */
export type DebtOverdueRow = Named & {
  debtMinor: number;
  lastPaidDay: string | null;
  daysUnpaid: number;
  lastTripDay: string | null;
  isNew: boolean;
  /** Got cargo in the period of the report. */
  gotCargo: boolean;
};

/**
 * The report on the debts of the clients for a day of the cash desk (see debt-report.ts of the server): how the debt
 * of all moved since the day compared with, the thirty who owe most, those who do not pay, the control sheet.
 */
export type DebtReport = {
  day: string;
  since: string;
  /** The first day of the history: a client with no payment at all has not paid since then. */
  historyFrom: string;
  /** The main cash desk; what another desk took is marked with that desk. */
  primaryKassa: string;
  openingMinor: number;
  closingMinor: number;
  chargedMinor: number;
  paidMinor: number;
  trips: Array<{ number: number; day: string; amountMinor: number; clients: number }>;
  chargedClients: number;
  paidElsewhere: Array<{ kassa: string; amountMinor: number }>;
  /** Day by day, when the period is longer than one. */
  days: Array<{ day: string; trips: Array<{ number: number; amountMinor: number }>; chargedMinor: number; paidMinor: number; closingMinor: number }>;
  payers: Array<Named & { amountMinor: number; kassas: string[]; debtMinor: number; closed: boolean }>;
  refunds: Array<Named & { amountMinor: number }>;
  charged: Array<Named & { amountMinor: number; trips: number[] }>;
  events: {
    closed: Named[];
    paidTrip: Array<Named & { trip: number; amountMinor: number; daysAfter: number; closed: boolean }>;
    firstPayment: Array<Named & { amountMinor: number; previousDay: string | null }>;
    crossed: { boundaryMinor: number; down: boolean } | null;
  };
  /** What was written into the days already closed; null when no closing of `since` was kept. */
  backdated: {
    takenAt: string;
    thenMinor: number;
    changes: Array<Named & { changeMinor: number }>;
    trips: Array<{ number: number; day: string; amountMinor: number; clients: number }>;
    topIn: Named[];
    topOut: Named[];
    overdueIn: Named[];
    overdueOut: Named[];
  } | null;
  debtors: { count: number; totalMinor: number };
  top: {
    rows: DebtTopRow[];
    totalMinor: number;
    left: Array<Named & { paidMinor: number; debtMinor: number; changeMinor: number }>;
    entered: Array<Named & { chargedMinor: number; trips: number[]; changeMinor: number }>;
    moved: Array<Named & { from: number; to: number }>;
    near: Array<Named & { days: number }>;
    crossed: Array<Named & { days: number }>;
  };
  overdue: {
    rows: DebtOverdueRow[];
    totalMinor: number;
    long: number;
    left: Array<Named & { paidMinor: number; debtMinor: number }>;
    came: Array<Named & { debtMinor: number; daysUnpaid: number; lastPaidDay: string | null; reason: "days" | "debt" }>;
  };
  control: { year: number; months: ControlMonth[]; agrees: boolean };
  /** The month as a whole, when `day` is its last day: what all the clients owed day by day. Null on any other day. */
  dynamics: {
    month: string;
    openingMinor: number;
    trips: number;
    days: Array<{ day: string; chargedMinor: number; paidMinor: number; closingMinor: number }>;
  } | null;
};

/** The report of a day (today's, unless said), compared with the day before it or with an earlier one. */
export async function fetchDebtReport(day?: string, since?: string): Promise<DebtReport> {
  const query = new URLSearchParams();
  if (day) query.set("day", day);
  if (since) query.set("since", since);
  const response = await request(query.size > 0 ? `/api/debts/report?${query}` : "/api/debts/report");
  if (response.status === 401) throw new SessionExpiredError("Session ended");
  if (!response.ok) throw new Error(`Unexpected status ${response.status} from /api/debts/report`);
  return (await response.json()) as DebtReport;
}

/** The sheet «Не платят больше 7 дней» of a day, as a workbook of Excel. */
export async function fetchUnpaidSheet(day: string): Promise<Blob> {
  const response = await request(`/api/debts/unpaid.xlsx?${new URLSearchParams({ day })}`, undefined, 30_000);
  if (response.status === 401) throw new SessionExpiredError("Session ended");
  if (!response.ok) throw new Error(`Unexpected status ${response.status} from /api/debts/unpaid.xlsx`);
  return response.blob();
}
