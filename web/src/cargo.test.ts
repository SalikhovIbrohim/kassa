import { describe, expect, it } from "vitest";
import {
  cargoAmountMinor,
  debtWords,
  formatCount,
  formatDebtInput,
  formatPrice,
  formatTripDay,
  formatWeight,
  formatWeightInput,
  moscowToday,
  parseCount,
  parseDebtInput,
  parsePriceInput,
  parseWeightInput,
} from "./cargo";

/** Non-breaking spaces are what the Russian formats put between thousands; the tests read them as plain ones. */
const plain = (text: string) => text.replace(/[  ]/g, " ");

describe("the numbers of the cargo", () => {
  it("reads a weight in kilograms into grams, by its digits", () => {
    expect(parseWeightInput("1075")).toBe(1_075_000);
    expect(parseWeightInput("1 075")).toBe(1_075_000);
    expect(parseWeightInput("547,02")).toBe(547_020);
    expect(parseWeightInput("3686.5")).toBe(3_686_500);
    expect(parseWeightInput("0,001")).toBe(1);
    for (const bad of ["", "0", "0,0", "-5", "12,3456", "1e3", "кг", "1,2,3", "99999999"]) expect(parseWeightInput(bad), bad).toBeNull();
  });

  it("reads the price of a kilogram into thousandths of a dollar, and nothing is a price too", () => {
    expect(parsePriceInput("1,55")).toBe(1550);
    expect(parsePriceInput("1.5")).toBe(1500);
    expect(parsePriceInput("2")).toBe(2000);
    expect(parsePriceInput("0")).toBe(0);
    expect(parsePriceInput("0,005")).toBe(5);
    for (const bad of ["", "-1", "1,5555", "abc", "1001"]) expect(parsePriceInput(bad), bad).toBeNull();
  });

  it("reads a count as a whole number, an empty field as none, and anything else as a mistake", () => {
    expect(parseCount("30")).toBe(30);
    expect(parseCount("36 000")).toBe(36_000);
    expect(parseCount("0")).toBe(0);
    expect(parseCount("  ")).toBeNull();
    expect(parseCount("1,5")).toBeUndefined();
    expect(parseCount("десять")).toBeUndefined();
    expect(parseCount("2000000", 1_000_000)).toBeUndefined();
  });

  it("reads what a client owed at the start, which may be money paid ahead", () => {
    expect(parseDebtInput("1200,50")).toBe(120_050);
    expect(parseDebtInput("200")).toBe(20_000);
    expect(parseDebtInput("-50")).toBe(-5_000);
    expect(parseDebtInput("−50,5")).toBe(-5_050);
    expect(parseDebtInput("")).toBe(0);
    expect(parseDebtInput("долг")).toBeNull();
    expect(parseDebtInput("1,234")).toBeNull();
    expect(formatDebtInput(120_050)).toBe("1200,50");
    expect(formatDebtInput(-5_000)).toBe("-50");
    expect(formatDebtInput(0)).toBe("0");
  });

  it("works out what a line comes to as the server does: to the cent, half up", () => {
    // The lines of the waybill of trip 190.
    expect(cargoAmountMinor(1_075_000, 1550)).toBe(166_625);
    expect(cargoAmountMinor(259_850, 1500)).toBe(38_978); // 389,775
    expect(cargoAmountMinor(530_850, 1500)).toBe(79_628); // 796,275
    expect(cargoAmountMinor(204_820, 1500)).toBe(30_723);
    expect(cargoAmountMinor(1, 1)).toBe(0);
    expect(cargoAmountMinor(1000, 0)).toBe(0);
  });

  it("writes weights, prices, counts and days for reading", () => {
    expect(plain(formatWeight(3_686_500))).toBe("3 686,5");
    expect(plain(formatWeight(547_020))).toBe("547,02");
    expect(plain(formatWeight(1_075_000))).toBe("1 075");
    expect(formatWeightInput(547_020)).toBe("547,02");
    expect(formatWeightInput(1_075_000)).toBe("1075");
    expect(formatPrice(1550)).toBe("1,55");
    expect(formatPrice(1500)).toBe("1,5");
    expect(formatPrice(2000)).toBe("2");
    expect(plain(formatCount(36_000))).toBe("36 000");
    expect(formatCount(null)).toBe("");
    expect(formatTripDay("2026-08-16")).toBe("16.08.2026");
    expect(formatTripDay(null)).toBe("");
  });

  it("says a debt, money paid ahead, and nothing owed apart", () => {
    expect(plain(debtWords(232_975).text)).toBe("долг 2 329,75 $");
    expect(debtWords(232_975).tone).toBe("debt");
    expect(plain(debtWords(-5_000).text)).toBe("предоплата 50,00 $");
    expect(debtWords(-5_000).tone).toBe("ahead");
    expect(debtWords(0)).toEqual({ text: "долга нет", tone: "even" });
  });

  it("takes today from the calendar of Moscow", () => {
    expect(moscowToday(new Date("2026-08-16T20:59:00Z"))).toBe("2026-08-16");
    expect(moscowToday(new Date("2026-08-16T21:00:00Z"))).toBe("2026-08-17");
  });
});
