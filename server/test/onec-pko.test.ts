import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { clientCodeOf, documentDate, dollarsOf, pickContract, pickCounterpart, postingIsRight } from "../src/onec-pko.js";

describe("the code of a client out of what the cashier typed", () => {
  it.each([
    ["A245", "А245", ""],
    ["а-245", "А245", ""],
    ["a 245", "А245", ""],
    ["А406 Жавид", "А406", "Жавид"],
    ["A 406 Жавид Хасанов", "А406", "Жавид Хасанов"],
    ["  А7  ", "А7", ""],
  ])("%s is the client %s", (typed, code, name) => {
    expect(clientCodeOf(typed)).toEqual({ code, name });
  });

  it.each(["", "Москва", "А чужой пул", "А", "245", "А123456", "Б245", "А245Б"])("%j is no code", (typed) => {
    expect(clientCodeOf(typed)).toBeNull();
  });

  it("is none for a missing text", () => {
    expect(clientCodeOf(null)).toBeNull();
  });
});

describe("finding the counterpart in 1C", () => {
  const row = (name: string, extra: Record<string, unknown> = {}) => ({ Ref_Key: `key-${name}`, Description: name, DeletionMark: false, IsFolder: false, ...extra });
  const client = (code: string, name = "") => ({ code, name });

  it("finds it by the code at the start of the name, whichever letter the name was written with", () => {
    // The second is written with a latin A.
    expect(pickCounterpart([row("А245 Исмоил"), row("A300 Другой")], client("А245"))).toEqual({ found: true, counterpart: { key: "key-А245 Исмоил", name: "А245 Исмоил" } });
    expect(pickCounterpart([row("A300 Другой")], client("А300"))).toMatchObject({ found: true });
  });

  it("finds it by the tax number that holds the code", () => {
    expect(pickCounterpart([row("ООО Ромашка", { ИНН: "339" })], client("А339"))).toMatchObject({ found: true });
  });

  it("does not take a real tax number for a code", () => {
    expect(pickCounterpart([row("ООО Ромашка", { ИНН: "7701234567" })], client("А339"))).toMatchObject({ found: false });
  });

  it("says there is none, and does not guess a near one", () => {
    const result = pickCounterpart([row("А2450 Не тот"), row("А24 Не тот")], client("А245"));
    expect(result).toMatchObject({ found: false });
    expect(result).toMatchObject({ reason: expect.stringContaining("А245") });
  });

  it("leaves out the deleted ones and the folders", () => {
    expect(pickCounterpart([row("А245 Старый", { DeletionMark: true }), row("А245 Папка", { IsFolder: true })], client("А245"))).toMatchObject({ found: false });
  });

  it("will not choose between two clients of one code", () => {
    const result = pickCounterpart([row("А466 Светлана"), row("А466 Ольга")], client("А466"));
    expect(result).toMatchObject({ found: false, reason: expect.stringContaining("несколько") });
  });

  it("tells two of one code apart by the name the cashier added", () => {
    const result = pickCounterpart([row("А466 Светлана"), row("А466 Ольга")], client("А466", "ольга"));
    expect(result).toEqual({ found: true, counterpart: { key: "key-А466 Ольга", name: "А466 Ольга" } });
  });

  it("does not accept a name that fits none of them", () => {
    expect(pickCounterpart([row("А466 Светлана")], client("А466", "Ольга"))).toMatchObject({ found: false, reason: expect.stringContaining("Ольга") });
  });
});

describe("finding the contract", () => {
  it("takes the contract named after the client, then any with a buyer, never a deleted one", () => {
    const rows = [
      { Ref_Key: "k1", Description: "Основной", ВидДоговора: "СПокупателем", DeletionMark: false },
      { Ref_Key: "k2", Description: "№А245 от 01.01.2026", ВидДоговора: "СПокупателем", DeletionMark: false },
      { Ref_Key: "k3", Description: "№А245 от 01.01.2025", ВидДоговора: "СПокупателем", DeletionMark: true },
    ];
    expect(pickContract(rows, "А245")).toEqual({ key: "k2", name: "№А245 от 01.01.2026" });
    expect(pickContract([rows[0]!, rows[2]!], "А245")).toEqual({ key: "k1", name: "Основной" });
  });

  it("is none when there is no contract with a buyer", () => {
    expect(pickContract([{ Ref_Key: "k1", Description: "Поставщик", ВидДоговора: "СПоставщиком", DeletionMark: false }], "А245")).toBeNull();
    expect(pickContract([], "А245")).toBeNull();
  });
});

describe("the sum of the document in dollars", () => {
  it("is the dollars as they are, and the rubles at the rate of the entry", () => {
    expect(dollarsOf({ currency: "USD", amountMinor: 70_000, rateE4: null })).toBe(70_000);
    // 1185.00 rub at 79.00 = 15.00 usd
    expect(dollarsOf({ currency: "RUB", amountMinor: 118_500, rateE4: 790_000 })).toBe(1_500);
  });

  it("is not known for rubles without a rate", () => {
    expect(dollarsOf({ currency: "RUB", amountMinor: 118_500, rateE4: null })).toBeNull();
  });
});

describe("the date of the document", () => {
  it("is the Moscow time of the entry, to the second", () => {
    expect(documentDate(new Date("2026-10-02T11:21:03.900Z"))).toBe("2026-10-02T14:21:03");
    expect(documentDate(new Date("2026-10-02T22:30:00Z"))).toBe("2026-10-03T01:30:00");
  });
});

describe("checking the postings of a document", () => {
  const codeOf = new Map([
    ["a5010", "5010"],
    ["a6310", "6310"],
    ["a4010", "4010"],
    ["a9430", "9430"],
  ]);
  const entry = (dr: string, cr: string, sum: number) => ({ AccountDr_Key: dr, AccountCr_Key: cr, Сумма: sum });

  it("accepts cash against an advance or against a debt, for the sum of the document", () => {
    expect(postingIsRight([entry("a5010", "a6310", 15)], codeOf, 1_500)).toBe(true);
    expect(postingIsRight([entry("a5010", "a4010", 10), entry("a5010", "a6310", 5)], codeOf, 1_500)).toBe(true);
  });

  it("refuses an empty posting, another sum and other accounts", () => {
    expect(postingIsRight([], codeOf, 1_500)).toBe(false);
    expect(postingIsRight([entry("a5010", "a6310", 14.99)], codeOf, 1_500)).toBe(false);
    expect(postingIsRight([entry("a5010", "a9430", 15)], codeOf, 1_500)).toBe(false);
    expect(postingIsRight([entry("a6310", "a5010", 15)], codeOf, 1_500)).toBe(false);
  });
});

describe("the settings of the writing to 1C", () => {
  const KEY = "0d2cb474-924a-11f1-8cb7-b8cb29f61f4c";
  const base = { DATABASE_URL: "postgres://kassa:x@localhost/kassa" };
  const full = {
    ...base,
    COSMO_1C_MODE: "live",
    COSMO_ODATA_URL: "http://1c.example/Cosmo",
    COSMO_ODATA_USER: "robot",
    COSMO_ODATA_PASSWORD: "s3cret",
    COSMO_1C_ORGANIZATION_KEY: KEY,
    COSMO_1C_KASSA_KEY: KEY.toUpperCase(),
    COSMO_1C_CURRENCY_KEY: KEY,
  };

  it("writes nothing unless it is turned on", () => {
    expect(loadConfig(base).onec).toBeUndefined();
    expect(loadConfig({ ...base, COSMO_1C_MODE: "off", COSMO_ODATA_URL: "x" }).onec).toBeUndefined();
  });

  it("reads the live and the preview settings, the keys in lower case, the list of clients as codes", () => {
    expect(loadConfig(full).onec).toEqual({
      url: "http://1c.example/Cosmo",
      user: "robot",
      password: "s3cret",
      organizationKey: KEY,
      kassaKey: KEY,
      currencyKey: KEY,
      mode: "live",
      onlyClients: undefined,
    });
    expect(loadConfig({ ...full, COSMO_1C_MODE: "Preview", COSMO_1C_CLIENTS: "a339, А-406" }).onec).toMatchObject({ mode: "preview", onlyClients: ["А339", "А406"] });
  });

  it("refuses a setting that is missing or wrong, without saying the password", () => {
    expect(() => loadConfig({ ...full, COSMO_1C_MODE: "yes" })).toThrow(/COSMO_1C_MODE/);
    expect(() => loadConfig({ ...full, COSMO_ODATA_URL: "" })).toThrow(/COSMO_ODATA_URL/);
    expect(() => loadConfig({ ...full, COSMO_1C_KASSA_KEY: "not-a-key" })).toThrow(/COSMO_1C_KASSA_KEY/);
    expect(() => loadConfig({ ...full, COSMO_1C_CLIENTS: "Москва" })).toThrow(/COSMO_1C_CLIENTS/);
    for (const broken of [{ COSMO_ODATA_USER: "" }, { COSMO_1C_CURRENCY_KEY: "x" }, { COSMO_1C_CLIENTS: "oops" }]) {
      try {
        loadConfig({ ...full, ...broken });
      } catch (error) {
        expect((error as Error).message).not.toContain("s3cret");
      }
    }
  });
});
