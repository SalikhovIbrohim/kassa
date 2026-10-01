import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { get, loginAs, postJson } from "./helpers/http.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

// 11:30 in Moscow (UTC+3), the middle of 5 March.
const NOW = new Date("2026-03-05T08:30:00Z");

type Who = "ivan" | "petr";

describe("the journal of operations", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** Two cashiers and the viewer, with plenty of money, the clock standing at NOW. */
  async function deskWithPeople() {
    const started = await startTestApp();
    started.setNow(NOW);
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "petr", password: "another good one", role: "cashier", displayName: "Пётр" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    await started.admin.setOpeningBalance("RUB", "1000000");
    await started.admin.setOpeningBalance("USD", "100000");
    app = started;
    return {
      started,
      ivan: await loginAs(started, "ivan", "correct horse"),
      petr: await loginAs(started, "petr", "another good one"),
      owner: await loginAs(started, "owner", "long enough pass"),
    };
  }

  type Entry = Record<string, unknown>;

  function income(overrides: Entry = {}): Entry {
    return { id: randomUUID(), type: "income", amountMinor: 100_000, currency: "RUB", clientCode: "K17", ...overrides };
  }

  function expense(overrides: Entry = {}): Entry {
    return { id: randomUUID(), type: "expense", amountMinor: 10_000, currency: "RUB", category: "fuel_road", ...overrides };
  }

  /** Records an operation as `cookie` with the clock set to `at`; returns its id. */
  async function record(started: TestApp, cookie: string, at: string, body: Entry): Promise<string> {
    started.setNow(new Date(at));
    const response = await postJson(started, "/api/operations", body, cookie);
    expect(response.status, await response.clone().text()).toBe(201);
    started.setNow(NOW);
    return body.id as string;
  }

  async function journal(started: TestApp, cookie: string, query = "") {
    const response = await get(started, `/api/operations${query}`, cookie);
    return { status: response.status, body: await response.json() };
  }

  const ids = (body: { operations: Array<{ id: string }> }) => body.operations.map((operation) => operation.id);

  describe("what comes back", () => {
    it("lists today's operations with the same fields the entry answers with, newest first", async () => {
      const { started, ivan } = await deskWithPeople();
      const first = income({ amountMinor: 150_050, comment: "за рейс" });
      const second = expense({ category: "owner_handover", amountMinor: 30_000, recipient: "Азамат" });
      await record(started, ivan, "2026-03-05T06:00:00Z", first);
      await record(started, ivan, "2026-03-05T07:00:00Z", second);

      const { status, body } = await journal(started, ivan);

      expect(status).toBe(200);
      expect(body).toEqual({
        from: "2026-03-05",
        to: "2026-03-05",
        operations: [
          {
            id: second.id,
            type: "expense",
            amountMinor: 30_000,
            currency: "RUB",
            category: "owner_handover",
            recipient: "Азамат",
            clientCode: null,
            comment: null,
            author: { login: "ivan", displayName: "Иван" },
            createdAt: "2026-03-05T07:00:00.000Z",
            shiftId: null,
            revision: 0,
            deletedAt: null,
            deletedBy: null,
          },
          {
            id: first.id,
            type: "income",
            amountMinor: 150_050,
            currency: "RUB",
            category: null,
            recipient: null,
            clientCode: "K17",
            comment: "за рейс",
            author: { login: "ivan", displayName: "Иван" },
            createdAt: "2026-03-05T06:00:00.000Z",
            shiftId: null,
            revision: 0,
            deletedAt: null,
            deletedBy: null,
          },
        ],
        nextCursor: null,
      });
    });

    it("is empty, not an error, on a day with nothing", async () => {
      const { started, ivan } = await deskWithPeople();

      const { status, body } = await journal(started, ivan);

      expect(status).toBe(200);
      expect(body.operations).toEqual([]);
      expect(body.nextCursor).toBeNull();
    });

    it("needs a login", async () => {
      const { started } = await deskWithPeople();

      expect((await journal(started, "")).status).toBe(401);
    });
  });

  describe("days are Moscow days", () => {
    it("starts a day at midnight Moscow time, not at midnight UTC", async () => {
      const { started, ivan } = await deskWithPeople();
      const lateYesterday = await record(started, ivan, "2026-03-04T20:59:59Z", income());
      const earlyToday = await record(started, ivan, "2026-03-04T21:00:00Z", income());
      const lateToday = await record(started, ivan, "2026-03-05T20:59:59Z", income());
      const earlyTomorrow = await record(started, ivan, "2026-03-05T21:00:00Z", income());

      const today = await journal(started, ivan, "?from=2026-03-05&to=2026-03-05");
      const yesterday = await journal(started, ivan, "?from=2026-03-04&to=2026-03-04");
      const tomorrow = await journal(started, ivan, "?from=2026-03-06&to=2026-03-06");

      expect(ids(today.body)).toEqual([lateToday, earlyToday]);
      expect(ids(yesterday.body)).toEqual([lateYesterday]);
      expect(ids(tomorrow.body)).toEqual([earlyTomorrow]);
    });

    it("takes 'today' from the application's clock in Moscow time", async () => {
      const { started, ivan } = await deskWithPeople();
      // 22:00 UTC on 5 March is already 6 March in Moscow.
      started.setNow(new Date("2026-03-05T22:00:00Z"));

      const { body } = await journal(started, ivan);

      expect(body).toMatchObject({ from: "2026-03-06", to: "2026-03-06" });
    });

    it("reads one bound on its own as that single day", async () => {
      const { started, owner, ivan } = await deskWithPeople();
      const onThird = await record(started, ivan, "2026-03-03T10:00:00Z", income());
      await record(started, ivan, "2026-03-05T10:00:00Z", income());

      const onlyFrom = await journal(started, owner, "?from=2026-03-03");
      const onlyTo = await journal(started, owner, "?to=2026-03-03");

      expect(onlyFrom.body).toMatchObject({ from: "2026-03-03", to: "2026-03-03" });
      expect(ids(onlyFrom.body)).toEqual([onThird]);
      expect(onlyTo.body).toMatchObject({ from: "2026-03-03", to: "2026-03-03" });
      expect(ids(onlyTo.body)).toEqual([onThird]);
    });
  });

  describe("what a cashier sees", () => {
    it("only their own operations, never a colleague's", async () => {
      const { started, ivan, petr } = await deskWithPeople();
      const mine = await record(started, ivan, "2026-03-05T06:00:00Z", income());
      await record(started, petr, "2026-03-05T07:00:00Z", income({ clientCode: "SECRET" }));

      const { body } = await journal(started, ivan);

      expect(ids(body)).toEqual([mine]);
      expect(JSON.stringify(body)).not.toContain("SECRET");
    });

    it("may name themselves as the author, in any letter case", async () => {
      const { started, ivan } = await deskWithPeople();
      const mine = await record(started, ivan, "2026-03-05T06:00:00Z", income());

      const { status, body } = await journal(started, ivan, "?author=IVAN");

      expect(status).toBe(200);
      expect(ids(body)).toEqual([mine]);
    });

    it("is refused when asking for a colleague's operations", async () => {
      const { started, ivan, petr } = await deskWithPeople();
      await record(started, petr, "2026-03-05T07:00:00Z", income());

      const { status, body } = await journal(started, ivan, "?author=petr");

      expect(status).toBe(403);
      expect(body.operations).toBeUndefined();
    });

    it("can look at any earlier day, still only at their own", async () => {
      const { started, ivan, petr } = await deskWithPeople();
      const mine = await record(started, ivan, "2026-03-02T10:00:00Z", income());
      await record(started, petr, "2026-03-02T11:00:00Z", income());

      const { body } = await journal(started, ivan, "?from=2026-03-02&to=2026-03-02");

      expect(ids(body)).toEqual([mine]);
    });
  });

  describe("what the viewer sees", () => {
    it("every cashier's operations", async () => {
      const { started, ivan, petr, owner } = await deskWithPeople();
      const fromIvan = await record(started, ivan, "2026-03-05T06:00:00Z", income());
      const fromPetr = await record(started, petr, "2026-03-05T07:00:00Z", expense());

      const { body } = await journal(started, owner);

      expect(ids(body)).toEqual([fromPetr, fromIvan]);
    });

    it("cannot record an operation: the request is refused and the journal stays as it was", async () => {
      const { started, owner } = await deskWithPeople();

      const refused = await postJson(started, "/api/operations", income(), owner);
      const { body } = await journal(started, owner);

      expect(refused.status).toBe(403);
      expect(body.operations).toEqual([]);
    });
  });

  describe("filters (for the viewer)", () => {
    /** One of each kind on 1 March, two more on 2 and 3 March. */
    async function filledJournal() {
      const desk = await deskWithPeople();
      const { started, ivan, petr } = desk;
      const made = {
        rubIncome: await record(started, ivan, "2026-03-01T06:00:00Z", income({ clientCode: "K17" })),
        usdIncome: await record(started, ivan, "2026-03-01T07:00:00Z", income({ currency: "USD", clientCode: "k18" })),
        fuel: await record(started, petr, "2026-03-01T08:00:00Z", expense({ category: "fuel_road" })),
        handover: await record(started, petr, "2026-03-01T09:00:00Z", expense({ category: "owner_handover" })),
        refund: await record(
          started,
          ivan,
          "2026-03-02T06:00:00Z",
          expense({ category: "client_refund", clientCode: "K17" }),
        ),
        usdExpense: await record(started, petr, "2026-03-03T06:00:00Z", expense({ currency: "USD", category: "other" })),
      };
      return { ...desk, made };
    }

    it("by period, both ends included", async () => {
      const { started, owner, made } = await filledJournal();

      const second = await journal(started, owner, "?from=2026-03-02&to=2026-03-02");
      const secondAndThird = await journal(started, owner, "?from=2026-03-02&to=2026-03-03");
      const all = await journal(started, owner, "?from=2026-03-01&to=2026-03-05");

      expect(ids(second.body)).toEqual([made.refund]);
      expect(ids(secondAndThird.body)).toEqual([made.usdExpense, made.refund]);
      expect(all.body.operations).toHaveLength(6);
    });

    it("by currency", async () => {
      const { started, owner, made } = await filledJournal();

      const { body } = await journal(started, owner, "?from=2026-03-01&to=2026-03-05&currency=USD");

      expect(ids(body)).toEqual([made.usdExpense, made.usdIncome]);
    });

    it("by type", async () => {
      const { started, owner, made } = await filledJournal();

      const incomes = await journal(started, owner, "?from=2026-03-01&to=2026-03-05&type=income");
      const expenses = await journal(started, owner, "?from=2026-03-01&to=2026-03-05&type=expense");

      expect(ids(incomes.body)).toEqual([made.usdIncome, made.rubIncome]);
      expect(ids(expenses.body)).toEqual([made.usdExpense, made.refund, made.handover, made.fuel]);
    });

    it("by category, which tells a handover to the owner from ordinary expenses", async () => {
      const { started, owner, made } = await filledJournal();

      const handovers = await journal(started, owner, "?from=2026-03-01&to=2026-03-05&category=owner_handover");
      const refunds = await journal(started, owner, "?from=2026-03-01&to=2026-03-05&category=client_refund");

      expect(ids(handovers.body)).toEqual([made.handover]);
      expect(ids(refunds.body)).toEqual([made.refund]);
    });

    it("by client code, in any letter case, finding incomes and refunds of that client", async () => {
      const { started, owner, made } = await filledJournal();

      const upper = await journal(started, owner, "?from=2026-03-01&to=2026-03-05&clientCode=K17");
      const lower = await journal(started, owner, "?from=2026-03-01&to=2026-03-05&clientCode=k18");

      expect(ids(upper.body)).toEqual([made.refund, made.rubIncome]);
      expect(ids(lower.body)).toEqual([made.usdIncome]);
    });

    it("by client code as a whole, not as the start of a longer one", async () => {
      const { started, owner } = await filledJournal();

      const { body } = await journal(started, owner, "?from=2026-03-01&to=2026-03-05&clientCode=K1");

      expect(body.operations).toEqual([]);
    });

    it("treats % and _ in a client code as ordinary characters", async () => {
      const { started, owner } = await filledJournal();

      const percent = await journal(started, owner, "?from=2026-03-01&to=2026-03-05&clientCode=%25");
      const underscore = await journal(started, owner, "?from=2026-03-01&to=2026-03-05&clientCode=K_7");

      expect(percent.body.operations).toEqual([]);
      expect(underscore.body.operations).toEqual([]);
    });

    it("by cashier, by login in any letter case", async () => {
      const { started, owner, made } = await filledJournal();

      const petr = await journal(started, owner, "?from=2026-03-01&to=2026-03-05&author=Petr");

      expect(ids(petr.body)).toEqual([made.usdExpense, made.handover, made.fuel]);
    });

    it("by several filters at once, all of which must hold", async () => {
      const { started, owner, made } = await filledJournal();

      const { body } = await journal(
        started,
        owner,
        "?from=2026-03-01&to=2026-03-05&author=ivan&type=income&currency=RUB",
      );

      expect(ids(body)).toEqual([made.rubIncome]);
    });

    it("finds nothing for an income with a category, since incomes have none", async () => {
      const { started, owner } = await filledJournal();

      const { status, body } = await journal(started, owner, "?from=2026-03-01&to=2026-03-05&type=income&category=other");

      expect(status).toBe(200);
      expect(body.operations).toEqual([]);
    });

    it("finds a cashier with a Cyrillic login whatever letter case the viewer types", async () => {
      const { started, owner } = await filledJournal();
      await started.admin.createUser({ login: "Азамат", password: "a fine password", role: "cashier" });
      const azamat = await loginAs(started, "Азамат", "a fine password");
      const theirs = await record(started, azamat, "2026-03-01T10:00:00Z", income());

      const lower = await journal(started, owner, "?from=2026-03-01&to=2026-03-05&author=" + encodeURIComponent("азамат"));
      const upper = await journal(started, owner, "?from=2026-03-01&to=2026-03-05&author=" + encodeURIComponent("АЗАМАТ"));

      expect(ids(lower.body)).toEqual([theirs]);
      expect(ids(upper.body)).toEqual([theirs]);
    });

    it("finds nothing for a cashier who does not exist, without an error", async () => {
      const { started, owner } = await filledJournal();

      const { status, body } = await journal(started, owner, "?from=2026-03-01&to=2026-03-05&author=nobody");

      expect(status).toBe(200);
      expect(body.operations).toEqual([]);
    });
  });

  describe("a cashier stays within their own operations under every filter and cursor", () => {
    async function twoCashiersTradingTurns() {
      const desk = await deskWithPeople();
      const { started, ivan, petr } = desk;
      const mine: string[] = [];
      const theirs: string[] = [];
      for (let hour = 1; hour <= 6; hour++) {
        const at = `2026-03-05T0${hour}:00:00Z`;
        // Same client code, currency and type on both sides, so only the author tells them apart.
        mine.push(await record(started, ivan, at, income({ clientCode: "K17", amountMinor: 100 + hour })));
        theirs.push(await record(started, petr, at, income({ clientCode: "K17", amountMinor: 200 + hour })));
      }
      return { ...desk, mine, theirs };
    }

    it("when filtering by currency, type and client code", async () => {
      const { started, ivan, mine } = await twoCashiersTradingTurns();

      const { body } = await journal(started, ivan, "?currency=RUB&type=income&clientCode=K17");

      expect([...ids(body)].sort()).toEqual([...mine].sort());
    });

    it("when asking for their own login as the author", async () => {
      const { started, ivan, mine } = await twoCashiersTradingTurns();

      const { body } = await journal(started, ivan, "?author=ivan");

      expect([...ids(body)].sort()).toEqual([...mine].sort());
    });

    it("page after page, even with a cursor taken from the viewer's view of everybody", async () => {
      const { started, ivan, owner, mine, theirs } = await twoCashiersTradingTurns();
      const everybody = await journal(started, owner, "?limit=3");

      // A cursor the viewer was given points into the middle of the colleagues' rows too.
      const seen: string[] = [];
      let cursor: string | null = everybody.body.nextCursor;
      let page = await journal(started, ivan, `?limit=2&cursor=${encodeURIComponent(cursor!)}`);
      for (;;) {
        seen.push(...ids(page.body));
        cursor = page.body.nextCursor;
        if (!cursor) break;
        page = await journal(started, ivan, `?limit=2&cursor=${encodeURIComponent(cursor)}`);
      }

      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((id) => mine.includes(id))).toBe(true);
      expect(seen.some((id) => theirs.includes(id))).toBe(false);
    });
  });

  describe("rejects a request it cannot answer", () => {
    it.each([
      ["a date that does not exist", "?from=2026-02-30&to=2026-03-01"],
      ["a date in the wrong format", "?from=05.03.2026"],
      ["a period that ends before it starts", "?from=2026-03-05&to=2026-03-04"],
      ["an unknown currency", "?currency=EUR"],
      ["an unknown type", "?type=transfer"],
      ["an unknown category", "?category=bribes"],
      ["an empty client code", "?clientCode="],
      ["a limit of zero", "?limit=0"],
      ["a limit above the maximum", "?limit=101"],
      ["a limit that is not a number", "?limit=ten"],
      ["a cursor that means nothing", "?cursor=not-a-cursor"],
      ["a parameter nobody knows", "?colour=red"],
      ["a client code with a NUL character", "?clientCode=a%00b"],
      ["an author with a NUL character", "?author=%00"],
      ["a cursor whose date is out of range", `?cursor=${Buffer.from("-271821-04-20T00:00:00.000000Z|" + randomUUID()).toString("base64url")}`],
      ["a cursor whose date is not a real day", `?cursor=${Buffer.from("2026-02-30T00:00:00.000000Z|" + randomUUID()).toString("base64url")}`],
      ["a cursor with a date and no id", `?cursor=${Buffer.from("2026-03-05T00:00:00.000000Z").toString("base64url")}`],
      ["a cursor with an id that is not a uuid", `?cursor=${Buffer.from("2026-03-05T00:00:00.000000Z|42").toString("base64url")}`],
    ])("%s", async (_name, query) => {
      const { started, owner } = await deskWithPeople();

      const { status } = await journal(started, owner, query);

      expect(status).toBe(400);
    });
  });

  describe("pages", () => {
    async function fiveOperationsAtTheSameMoment() {
      const desk = await deskWithPeople();
      const created: string[] = [];
      for (let index = 0; index < 5; index++) {
        created.push(await record(desk.started, desk.ivan, "2026-03-05T06:00:00Z", income({ amountMinor: 100 + index })));
      }
      return { ...desk, created };
    }

    it("hands over a page at a time, with a cursor for the next one until the end", async () => {
      const { started, owner, created } = await fiveOperationsAtTheSameMoment();

      const first = await journal(started, owner, "?limit=2");
      const second = await journal(started, owner, `?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
      const third = await journal(started, owner, `?limit=2&cursor=${encodeURIComponent(second.body.nextCursor)}`);

      expect(first.body.operations).toHaveLength(2);
      expect(second.body.operations).toHaveLength(2);
      expect(third.body.operations).toHaveLength(1);
      expect(third.body.nextCursor).toBeNull();
      // Every operation exactly once, though all five share one moment.
      const seen = [...ids(first.body), ...ids(second.body), ...ids(third.body)];
      expect([...seen].sort()).toEqual([...created].sort());
    });

    it("has no cursor when the last page is exactly full", async () => {
      const { started, owner } = await fiveOperationsAtTheSameMoment();

      const { body } = await journal(started, owner, "?limit=5");

      expect(body.operations).toHaveLength(5);
      expect(body.nextCursor).toBeNull();
    });

    it("keeps the period and filters of the first request working through the cursor", async () => {
      const { started, owner, ivan } = await deskWithPeople();
      const old = await record(started, ivan, "2026-03-01T06:00:00Z", income({ currency: "USD" }));
      await record(started, ivan, "2026-03-02T06:00:00Z", income());
      await record(started, ivan, "2026-03-03T06:00:00Z", income({ currency: "USD" }));
      const query = "?from=2026-03-01&to=2026-03-05&currency=USD&limit=1";

      const first = await journal(started, owner, query);
      const second = await journal(started, owner, `${query}&cursor=${encodeURIComponent(first.body.nextCursor)}`);

      expect(first.body.operations).toHaveLength(1);
      expect(ids(second.body)).toEqual([old]);
      expect(second.body.nextCursor).toBeNull();
    });

    it("does not skip operations written within the same millisecond, however fine their time is", async () => {
      const { started, owner, ivan } = await deskWithPeople();
      const me = await (await get(started, "/api/me", ivan)).json();
      expect(me.user.login).toBe("ivan");
      // Finer than a millisecond: the application never writes such times, but SQL can.
      const made: string[] = [];
      for (const micros of ["123100", "123200", "123300", "123400"]) {
        const id = randomUUID();
        made.push(id);
        await started.execute(
          `INSERT INTO operations (id, kind, amount_minor, currency, client_code, client_code_key, author_id, created_at)
           SELECT $1, 'income', 100, 'RUB', 'K1', 'k1', id, $2::timestamptz FROM users WHERE login = 'ivan'`,
          [id, `2026-03-05 06:00:00.${micros}+00`],
        );
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await journal(started, owner, `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        seen.push(...ids(page.body));
        cursor = page.body.nextCursor;
      } while (cursor);

      // Newest first: the latest microsecond comes first.
      expect(seen).toEqual([...made].reverse());
    });

    it("returns 50 at most by default", async () => {
      const { started, owner, ivan } = await deskWithPeople();
      await Promise.all(
        Array.from({ length: 52 }, () => postJson(started, "/api/operations", income({ amountMinor: 1 }), ivan)),
      );

      const { body } = await journal(started, owner);

      expect(body.operations).toHaveLength(50);
      expect(body.nextCursor).not.toBeNull();
    });
  });

  describe("the list of cashiers, for the viewer's filter", () => {
    it("names every cashier, including one whose access was withdrawn, and no viewer", async () => {
      const { started, owner } = await deskWithPeople();
      await started.admin.revokeUser("petr");

      const response = await get(started, "/api/cashiers", owner);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        cashiers: [
          { login: "ivan", displayName: "Иван" },
          { login: "petr", displayName: "Пётр" },
        ],
      });
    });

    it("is for the viewer only", async () => {
      const { started, ivan } = await deskWithPeople();

      expect((await get(started, "/api/cashiers", ivan)).status).toBe(403);
      expect((await get(started, "/api/cashiers")).status).toBe(401);
    });
  });
});
