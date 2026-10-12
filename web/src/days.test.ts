import { describe, expect, it } from "vitest";
import { cashDayToday, presetPeriod } from "./days";

describe("the day of the cash desk", () => {
  it("begins at 03:00 Moscow time, which is midnight UTC: the night after midnight still belongs to the day that ends", () => {
    expect(cashDayToday(new Date("2026-03-05T08:30:00Z"))).toBe("2026-03-05");
    // 01:00 on the 6th in Moscow.
    expect(cashDayToday(new Date("2026-03-05T22:00:00Z"))).toBe("2026-03-05");
    // 02:59:59 and then 03:00:00 on the 6th.
    expect(cashDayToday(new Date("2026-03-05T23:59:59Z"))).toBe("2026-03-05");
    expect(cashDayToday(new Date("2026-03-06T00:00:00Z"))).toBe("2026-03-06");
  });
});

describe("the quick choices of a period", () => {
  it("is today for today, and the day before for yesterday, across the end of a month", () => {
    expect(presetPeriod("today", "2026-03-10")).toEqual({ from: "2026-03-10", to: "2026-03-10" });
    expect(presetPeriod("yesterday", "2026-03-01")).toEqual({ from: "2026-02-28", to: "2026-02-28" });
  });

  it("is seven days with today for a week, and from the first of the month to today for a month", () => {
    expect(presetPeriod("week", "2026-03-10")).toEqual({ from: "2026-03-04", to: "2026-03-10" });
    expect(presetPeriod("week", "2026-03-03")).toEqual({ from: "2026-02-25", to: "2026-03-03" });
    expect(presetPeriod("month", "2026-03-10")).toEqual({ from: "2026-03-01", to: "2026-03-10" });
    expect(presetPeriod("month", "2026-12-31")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });
});
