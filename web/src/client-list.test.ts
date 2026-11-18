import { describe, expect, it } from "vitest";
import type { Client } from "./api";
import { hintOf, isDebtor, isLate, shortDayOf, shownClients, totalsOf } from "./client-list";

const client = (code: string, name: string, debtMinor: number, daysUnpaid: number, more: Partial<Client> = {}): Client => ({ code, name, phone: null, note: null, active: true, debtMinor, daysUnpaid, lastPaidDay: null, lastTripDay: null, ...more });

/** Seven clients: two who owe and pay, three who owe and do not, one who paid a little ahead, one who owes nothing. */
const CLIENTS = [
  client("1", "Улугбек", 1_720_000, 1),
  client("2", "Захар", 520_000, 7, { phone: "+7 900 111-22-33" }),
  client("3", "Рахим", 90_000, 320),
  client("4", "Тимур", 0, 1),
  client("5", "Марсел", -43, 1),
  client("6", "Аброр", 98_403, 31),
  client("7", "Саша", 230_000, 95),
];
const codes = (list: readonly Client[]) => list.map((item) => item.code);

describe("the list of clients with their debts", () => {
  it("counts a debtor from a dollar up, and someone who does not pay from 500 $ and thirty days", () => {
    expect(isDebtor(client("9", "К", 101, 0))).toBe(true);
    expect(isDebtor(client("9", "К", 100, 0))).toBe(false);
    expect(isDebtor(client("9", "К", -500, 0))).toBe(false);
    expect(isLate(client("9", "К", 50_001, 30))).toBe(true);
    expect(isLate(client("9", "К", 50_001, 29))).toBe(false);
    expect(isLate(client("9", "К", 50_000, 300))).toBe(false);
  });

  it("adds up what all owe and what was paid ahead as two sums, and those who do not pay", () => {
    expect(totalsOf(CLIENTS)).toEqual({ owedMinor: 2_658_403, debtors: 5, aheadMinor: 43, late: 3, lateMinor: 418_403 });
    expect(totalsOf([])).toEqual({ owedMinor: 0, debtors: 0, aheadMinor: 0, late: 0, lateMinor: 0 });
  });

  it("shows those who owe, everybody, or those who do not pay", () => {
    expect(codes(shownClients(CLIENTS, { filter: "debtors", sort: "debt", search: "" }))).toEqual(["1", "2", "7", "6", "3"]);
    expect(codes(shownClients(CLIENTS, { filter: "all", sort: "debt", search: "" }))).toEqual(["1", "2", "7", "6", "3", "4", "5"]);
    expect(codes(shownClients(CLIENTS, { filter: "late", sort: "debt", search: "" }))).toEqual(["7", "6", "3"]);
  });

  it("puts them in order: by the debt, by the code as a person reads it, by how long they have not paid", () => {
    expect(codes(shownClients(CLIENTS, { filter: "all", sort: "code", search: "" }))).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(codes(shownClients([client("77", "К", 0, 0), client("707", "К", 0, 0), client("9", "К", 0, 0)], { filter: "all", sort: "code", search: "" }))).toEqual(["9", "77", "707"]);
    // Longest without a payment first; who owes nothing is behind with nothing and comes last.
    expect(codes(shownClients(CLIENTS, { filter: "all", sort: "days", search: "" }))).toEqual(["3", "7", "6", "2", "1", "4", "5"]);
  });

  it("finds by the beginning of the code, a part of the name or of the phone, among those the filter keeps", () => {
    expect(codes(shownClients(CLIENTS, { filter: "all", sort: "code", search: " ра " }))).toEqual(["3"]);
    expect(codes(shownClients(CLIENTS, { filter: "all", sort: "code", search: "111-22" }))).toEqual(["2"]);
    // «7» is the code of one and in the phone of another.
    expect(codes(shownClients(CLIENTS, { filter: "all", sort: "code", search: "7" }))).toEqual(["2", "7"]);
    expect(codes(shownClients(CLIENTS, { filter: "debtors", sort: "code", search: "тимур" }))).toEqual([]);
    // A Latin A typed for the letter of a code.
    expect(codes(shownClients([client("А707", "Карим", 0, 0)], { filter: "all", sort: "code", search: "a70" }))).toEqual(["А707"]);
  });

  it("says under the name when they paid last and when their last truck came", () => {
    expect(shortDayOf("2026-11-16", "2026-11-17")).toBe("16.11");
    expect(shortDayOf("2025-12-30", "2026-01-02")).toBe("30.12.25");
    expect(hintOf(client("1", "К", 0, 0, { lastPaidDay: "2026-11-16", lastTripDay: "2026-11-14" }), "2026-11-17")).toBe("Оплата 16.11 · рейс 14.11");
    expect(hintOf(client("1", "К", 0, 0, { lastTripDay: "2026-11-14" }), "2026-11-17")).toBe("Оплат не было · рейс 14.11");
    expect(hintOf(client("1", "К", 0, 0, { lastPaidDay: "2026-11-16" }), "2026-11-17")).toBe("Оплата 16.11");
    expect(hintOf(client("1", "К", 0, 0), "2026-11-17")).toBe("Оплат не было");
  });
});
