import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperation, fetchCurrentUser, fetchCategories, NetworkError, SessionExpiredError, type OperationInput } from "./api";
import { forgetUser, rememberedUser, rememberUser } from "./remembered-user";

/** localStorage as a phone has it, for code that runs in Node. */
function stubStorage() {
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  });
  return items;
}

const CATEGORIES = [
  { code: "fuel_road", label: "Топливо и дорога" },
  { code: "other", label: "Прочее" },
];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("the expense categories on a phone without a connection", () => {
  beforeEach(() => void stubStorage());
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the list it was given, and uses it when the server cannot be reached", async () => {
    vi.stubGlobal("fetch", async () => json(200, { categories: CATEGORIES }));
    expect(await fetchCategories()).toEqual(CATEGORIES);

    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });

    expect(await fetchCategories()).toEqual(CATEGORIES);
  });

  it("uses it also when the server answers with an error of its own", async () => {
    vi.stubGlobal("fetch", async () => json(200, { categories: CATEGORIES }));
    await fetchCategories();

    vi.stubGlobal("fetch", async () => json(502, {}));

    expect(await fetchCategories()).toEqual(CATEGORIES);
  });

  it("does not hide that the session has ended", async () => {
    vi.stubGlobal("fetch", async () => json(200, { categories: CATEGORIES }));
    await fetchCategories();

    vi.stubGlobal("fetch", async () => json(401, {}));

    await expect(fetchCategories()).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("fails as before when there is no connection and nothing was kept", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(fetchCategories()).rejects.toThrow();
  });

  it("ignores a kept list that is not a list of categories", async () => {
    const items = stubStorage();
    items.set("kassa.categories", '[{"code": 1}]');
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(fetchCategories()).rejects.toThrow();
  });
});

describe("the cashier remembered for opening the app without a connection", () => {
  beforeEach(() => void stubStorage());
  afterEach(() => vi.unstubAllGlobals());

  const ivan = { login: "ivan", displayName: "Иван", role: "cashier" } as const;

  it("is the one signed in last, until they sign out", () => {
    expect(rememberedUser()).toBeNull();

    rememberUser(ivan);
    expect(rememberedUser()).toEqual(ivan);

    forgetUser();
    expect(rememberedUser()).toBeNull();
  });

  it("is nobody when what is kept is not a user", () => {
    const items = stubStorage();
    for (const garbage of ["not json", "{}", '{"login":"x"}', '{"login":"x","displayName":"X","role":"boss"}']) {
      items.set("kassa.user", garbage);
      expect(rememberedUser(), garbage).toBeNull();
    }
  });

  it("does not fail when the phone gives no storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });

    expect(() => rememberUser(ivan)).not.toThrow();
    expect(() => forgetUser()).not.toThrow();
    expect(rememberedUser()).toBeNull();
  });
});

describe("sending an entry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const entry: OperationInput = {
    type: "income",
    id: "00000000-0000-4000-8000-000000000001",
    amountMinor: 50_000,
    currency: "RUB",
    clientCode: "K17",
  };
  const operation = { ...entry, category: null, recipient: null, comment: null, author: { login: "ivan", displayName: "Иван" }, createdAt: "2026-03-05T08:30:00.000Z", shiftId: null, revision: 0, deletedAt: null, deletedBy: null };

  it("says whose entry it is, in a form that a header can carry in any alphabet", async () => {
    let headers: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return json(201, { operation, balances: [] });
    });

    await createOperation(entry, "Иван.П");

    expect(headers["x-kassa-as"]).toBe(encodeURIComponent("Иван.П"));
    expect(decodeURIComponent(headers["x-kassa-as"]!)).toBe("Иван.П");
  });

  it("takes a 200 for the entry only when the answer is about this entry", async () => {
    for (const [what, body] of [
      ["nothing", {}],
      ["another entry", { operation: { ...operation, id: "00000000-0000-4000-8000-000000000002" }, balances: [] }],
      ["no balances", { operation }],
    ] as const) {
      vi.stubGlobal("fetch", async () => json(200, body));
      expect(await createOperation(entry, "ivan"), what).toEqual({ ok: false, reason: "server-error" });
    }
    // A page of a captive portal or a proxy, which is not JSON at all.
    vi.stubGlobal("fetch", async () => new Response("<html>Please sign in to the Wi-Fi</html>", { status: 200 }));
    expect(await createOperation(entry, "ivan")).toEqual({ ok: false, reason: "server-error" });

    vi.stubGlobal("fetch", async () => json(200, { operation, balances: [{ currency: "RUB", amountMinor: 50_000 }] }));
    expect(await createOperation(entry, "ivan")).toMatchObject({ ok: true });
  });

  it("tells a session of another cashier from an id that is already taken", async () => {
    vi.stubGlobal("fetch", async () => json(409, { error: "wrong_session" }));
    expect(await createOperation(entry, "ivan")).toEqual({ ok: false, reason: "wrong-session" });

    vi.stubGlobal("fetch", async () => json(409, { error: "operation_id_conflict" }));
    expect(await createOperation(entry, "ivan")).toEqual({ ok: false, reason: "conflict" });
  });

  it("treats answers that say not now, and not no, as a try again later", async () => {
    for (const status of [404, 405, 408, 425, 429, 500, 502, 503, 504]) {
      vi.stubGlobal("fetch", async () => json(status, {}));
      expect(await createOperation(entry, "ivan"), String(status)).toEqual({ ok: false, reason: "server-error" });
    }
    vi.stubGlobal("fetch", async () => json(400, {}));
    expect(await createOperation(entry, "ivan")).toEqual({ ok: false, reason: "rejected" });
  });

  it("counts a server that does not answer as a lost connection, after ten seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));

    const sending = createOperation(entry, "ivan");
    const failed = expect(sending).rejects.toBeInstanceOf(NetworkError);
    await vi.advanceTimersByTimeAsync(9_999);
    await vi.advanceTimersByTimeAsync(2);
    await failed;
  });

  it("gives up on asking who is signed in after five seconds, so that the app can open with the cashier it remembers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));

    const asking = fetchCurrentUser();
    const failed = expect(asking).rejects.toBeInstanceOf(NetworkError);
    await vi.advanceTimersByTimeAsync(5_001);
    await failed;
  });
});
