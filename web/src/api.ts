export type Role = "cashier" | "viewer";

export type User = {
  login: string;
  displayName: string;
  role: Role;
};

/** The server could not be reached at all (no connection, server down). */
export class NetworkError extends Error {}

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
