import type { User } from "./api";

const KEY = "kassa.user";

/**
 * The cashier who was signed in last, so that the app can open without a connection and still let
 * them make entries. It is only a name for the screen: the session itself is the server's cookie,
 * and what is sent still needs it.
 */
export function rememberUser(user: User) {
  try {
    localStorage.setItem(KEY, JSON.stringify(user));
  } catch {
    // not remembered; the app then just says that there is no connection
  }
}

export function forgetUser() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to do
  }
}

export function rememberedUser(): User | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<User>;
    if (typeof value.login === "string" && typeof value.displayName === "string" && (value.role === "cashier" || value.role === "head_cashier" || value.role === "admin" || value.role === "guest" || value.role === "viewer")) {
      // The city is the cash desk the person works in: without it an entry made without a connection would be of another desk.
      const city = typeof value.city === "string" && value.city !== "" ? { city: value.city } : {};
      return { login: value.login, displayName: value.displayName, role: value.role, ...city };
    }
  } catch {
    // unreadable: as if there was none
  }
  return null;
}
