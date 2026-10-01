const KEY = "kassa.shift";

/**
 * The shift this cashier had open the last time the phone heard from the server. An entry made without a
 * connection says which shift it belongs to by this, so that it lands there when it is sent later.
 */
export function rememberShift(login: string, shiftId: string | null) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ login, shiftId }));
  } catch {
    // not remembered; an entry then belongs to whichever shift of the author is open when it arrives
  }
}

export function rememberedShift(login: string): string | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as { login?: unknown; shiftId?: unknown } | null;
    return value && value.login === login && typeof value.shiftId === "string" ? value.shiftId : null;
  } catch {
    return null;
  }
}
