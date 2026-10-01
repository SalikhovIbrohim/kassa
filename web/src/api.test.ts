import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCategories, SessionExpiredError } from "./api";
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
