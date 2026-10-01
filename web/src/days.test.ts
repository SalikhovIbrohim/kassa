import { describe, expect, it } from "vitest";
import { presetPeriod } from "./days";

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
