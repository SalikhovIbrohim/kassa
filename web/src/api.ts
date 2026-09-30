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
  type: "income";
  amountMinor: number;
  currency: Currency;
  clientCode: string;
  comment: string | null;
  author: { login: string; displayName: string };
  createdAt: string;
};

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

export type IncomeInput = {
  /** Made once per entry and kept across retries, so a retry can never count twice. */
  id: string;
  amountMinor: number;
  currency: Currency;
  clientCode: string;
  comment?: string;
};

export type IncomeResult =
  | { ok: true; operation: Operation; balances: Balance[] }
  | { ok: false; reason: "session-expired" | "forbidden" | "conflict" | "rejected" };

export async function createIncome(input: IncomeInput): Promise<IncomeResult> {
  const response = await request("/api/operations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "income", ...input }),
  });
  if (response.ok) {
    const body = (await response.json()) as { operation: Operation; balances: Balance[] };
    return { ok: true, ...body };
  }
  if (response.status === 401) return { ok: false, reason: "session-expired" };
  if (response.status === 403) return { ok: false, reason: "forbidden" };
  if (response.status === 409) return { ok: false, reason: "conflict" };
  return { ok: false, reason: "rejected" };
}
