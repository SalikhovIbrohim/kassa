export type Role = "cashier" | "viewer";

export type User = {
  login: string;
  displayName: string;
  role: Role;
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
  /** Only expenses have a category. */
  category: string | null;
  recipient: string | null;
  clientCode: string | null;
  comment: string | null;
  author: { login: string; displayName: string };
  createdAt: string;
  /** How many times it was corrected or deleted; 0 means as first written. */
  revision: number;
  /** Set when the operation was deleted: only the viewer ever receives such operations. */
  deletedAt: string | null;
  deletedBy: { login: string; displayName: string } | null;
};

export type Category = { code: string; label: string };

/** The one category that needs a client code. */
export const REFUND_CATEGORY = "client_refund";

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
    const parsed = raw ? (JSON.parse(raw) as Category[]) : null;
    return Array.isArray(parsed) && parsed.every((item) => typeof item?.code === "string" && typeof item?.label === "string") ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The expense categories. The list hardly ever changes, so the last one seen is kept on the phone and
 * used when the server cannot be asked: an expense can be entered without a connection.
 */
export async function fetchCategories(): Promise<Category[]> {
  try {
    const response = await request("/api/categories");
    if (response.status === 401) throw new SessionExpiredError("Session ended");
    if (!response.ok) throw new Error(`Unexpected status ${response.status} from /api/categories`);
    const categories = ((await response.json()) as { categories: Category[] }).categories;
    try {
      localStorage.setItem(CATEGORIES_KEY, JSON.stringify(categories));
    } catch {
      // not kept; the next visit with a connection tries again
    }
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
  amountMinor: number;
  currency: Currency;
  comment?: string;
};

export type OperationInput =
  | (EntryBase & { type: "income"; clientCode: string })
  | (EntryBase & {
      type: "expense";
      category: string;
      recipient?: string;
      /** Only for a client refund. */
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
    }
  /** An expense above what the cash desk holds: the server says how much there is. */
  | { ok: false; reason: "insufficient-balance"; currency: Currency; availableMinor: number };

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
  if (response.status === 422) {
    const body = (await response.json().catch(() => null)) as {
      currency?: Currency;
      availableMinor?: number;
    } | null;
    if (body?.currency && typeof body.availableMinor === "number") {
      return {
        ok: false,
        reason: "insufficient-balance",
        currency: body.currency,
        availableMinor: body.availableMinor,
      };
    }
  }
  // The server itself failed, or is busy: the entry may or may not have been saved, which is not the
  // data's fault and must not be reported as if it were.
  if (response.status >= 500 || TRY_AGAIN_LATER.has(response.status)) return { ok: false, reason: "server-error" };
  return { ok: false, reason: "rejected" };
}

// ---- Journal ----

export type Cashier = { login: string; displayName: string };

export type JournalFilters = {
  /** Moscow calendar days, YYYY-MM-DD, both included. */
  from: string;
  to: string;
  currency?: Currency;
  type?: "income" | "expense";
  category?: string;
  clientCode?: string;
  author?: string;
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

// ---- Corrections and history ----

export type Snapshot = {
  amountMinor: number;
  currency: Currency;
  category: string | null;
  recipient: string | null;
  clientCode: string | null;
  comment: string | null;
};

type EditBase = {
  amountMinor: number;
  currency: Currency;
  comment?: string;
  /** Why, in the person's words. Optional. */
  reason?: string;
};

/** What a correction sends: the whole of what the operation should say now. */
export type EditInput =
  | (EditBase & { type: "income"; clientCode: string })
  | (EditBase & { type: "expense"; category: string; recipient?: string; clientCode?: string });

export type ChangeResult =
  | { ok: true; operation: Operation; balances: Balance[] }
  | { ok: false; reason: "session-expired" | "forbidden" | "not-found" | "deleted" | "rejected" | "server-error" }
  /** The change would leave less than nothing of a currency in the cash desk. */
  | { ok: false; reason: "would-go-negative"; currency: Currency; balanceMinor: number; balanceAfterMinor: number };

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
  if (response.status === 422) {
    const body = (await response.json().catch(() => null)) as {
      currency?: Currency;
      balanceMinor?: number;
      balanceAfterMinor?: number;
    } | null;
    if (body?.currency && typeof body.balanceMinor === "number" && typeof body.balanceAfterMinor === "number") {
      return {
        ok: false,
        reason: "would-go-negative",
        currency: body.currency,
        balanceMinor: body.balanceMinor,
        balanceAfterMinor: body.balanceAfterMinor,
      };
    }
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
