import { afterEach, describe, expect, it, vi } from "vitest";
import { formatAmountText } from "./AmountInput";
import { formatRate, formatRateInput, parseRateInput } from "./money";
import { rememberedRate, rememberRate } from "./remembered-rate";

describe("the rate typed by a cashier", () => {
  it("reads whole rubles and up to four decimals, with a comma or a dot", () => {
    expect(parseRateInput("79")).toBe(790_000);
    expect(parseRateInput("78,4")).toBe(784_000);
    expect(parseRateInput("78.2345")).toBe(782_345);
    expect(parseRateInput(" 1 000 ")).toBe(10_000_000);
  });

  it("refuses what is not a rate from 1 to 1000", () => {
    for (const text of ["", "0", "0,5", "1001", "78,23456", "abc", "-79", "79,"]) expect(parseRateInput(text), text).toBeNull();
  });

  it("is shown the way it is typed, and for reading with two decimals at least", () => {
    expect(formatRateInput(784_000)).toBe("78,4");
    expect(formatRateInput(790_000)).toBe("79");
    expect(formatRate(790_000)).toBe("79,00");
    expect(formatRate(762_000)).toBe("76,20");
    expect(formatRate(782_345)).toBe("78,2345");
  });

  it("is typed with at most four whole digits and four decimals", () => {
    const shape = { decimals: 4, wholeDigits: 4 };
    expect(formatAmountText("78,23456", shape)).toBe("78,2345");
    expect(formatAmountText("12345", shape)).toBe("1 234");
    expect(formatAmountText("79", shape)).toBe("79");
  });
});

describe("the rate remembered for today", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is there the same Moscow day, and gone the next", () => {
    const kept = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
    });
    const noon = new Date("2026-03-05T09:00:00Z");
    rememberRate(787_000, noon);

    expect(rememberedRate(new Date("2026-03-05T20:00:00Z"))).toBe(787_000);
    expect(rememberedRate(new Date("2026-03-06T09:00:00Z"))).toBeNull();
  });
});
