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

async function request(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, { credentials: "same-origin", ...init });
  } catch {
    throw new NetworkError(`Cannot reach the server for ${path}`);
  }
}

/** The person behind the session cookie, or null when nobody is logged in. */
export async function fetchCurrentUser(): Promise<User | null> {
  const response = await request("/api/me");
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`Unexpected status ${response.status} from /api/me`);
  const body = (await response.json()) as { user: User };
  return body.user;
}

export type LoginResult =
  | { ok: true; user: User }
  | { ok: false; reason: "wrong-credentials" | "failed" };

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

export async function fetchCategories(): Promise<Category[]> {
  const response = await request("/api/categories");
  if (response.status === 401) throw new SessionExpiredError("Session ended");
  if (!response.ok) throw new Error(`Unexpected status ${response.status} from /api/categories`);
  return ((await response.json()) as { categories: Category[] }).categories;
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
  | { ok: false; reason: "session-expired" | "forbidden" | "conflict" | "rejected" }
  /** An expense above what the cash desk holds: the server says how much there is. */
  | { ok: false; reason: "insufficient-balance"; currency: Currency; availableMinor: number };

export async function createOperation(input: OperationInput): Promise<OperationResult> {
  const response = await request("/api/operations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.ok) {
    const body = (await response.json()) as { operation: Operation; balances: Balance[] };
    return { ok: true, ...body };
  }
  if (response.status === 401) return { ok: false, reason: "session-expired" };
  if (response.status === 403) return { ok: false, reason: "forbidden" };
  if (response.status === 409) return { ok: false, reason: "conflict" };
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
