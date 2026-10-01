import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { deleteRequest, get, loginAs, postJson, putJson } from "./helpers/http.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";
import { withRate } from "./helpers/entries.js";

// 11:30 in Moscow (UTC+3), the middle of 5 March.
const NOW = new Date("2026-03-05T08:30:00Z");
const LATER = new Date("2026-03-05T09:45:00Z");

type Entry = Record<string, unknown>;

describe("correcting and deleting operations", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** Two cashiers and the viewer. `opening` is what the cash desk holds to begin with. */
  async function desk(opening: { RUB?: string; USD?: string } = {}) {
    const started = await startTestApp();
    started.setNow(NOW);
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "petr", password: "another good one", role: "cashier", displayName: "Пётр" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    for (const [currency, amount] of Object.entries(opening)) {
      await started.admin.setOpeningBalance(currency, amount);
    }
    app = started;
    return {
      started,
      ivan: await loginAs(started, "ivan", "correct horse"),
      petr: await loginAs(started, "petr", "another good one"),
      owner: await loginAs(started, "owner", "long enough pass"),
    };
  }

  function income(overrides: Entry = {}): Entry {
    return withRate({ id: randomUUID(), type: "income", amountMinor: 50_000, currency: "RUB", clientCode: "K17", ...overrides });
  }

  function expense(overrides: Entry = {}): Entry {
    return { id: randomUUID(), type: "expense", amountMinor: 10_000, currency: "RUB", category: "fuel_road", ...overrides };
  }

  /** Records an entry and returns its id. */
  async function record(started: TestApp, cookie: string, body: Entry): Promise<string> {
    const response = await postJson(started, "/api/operations", body, cookie);
    expect(response.status, await response.clone().text()).toBe(201);
    return body.id as string;
  }

  async function balances(started: TestApp, cookie: string) {
    return (await (await get(started, "/api/balances", cookie)).json()).balances as Array<{
      currency: string;
      amountMinor: number;
    }>;
  }

  async function journalIds(started: TestApp, cookie: string, query = "") {
    const body = await (await get(started, `/api/operations${query}`, cookie)).json();
    return (body.operations as Array<{ id: string }>).map((operation) => operation.id);
  }

  const remove = (started: TestApp, cookie: string | undefined, id: string, reason?: unknown) =>
    deleteRequest(started, `/api/operations/${id}`, cookie, reason === undefined ? undefined : { reason });

  const edit = (started: TestApp, cookie: string | undefined, id: string, body: Entry) =>
    putJson(started, `/api/operations/${id}`, body, cookie);

  /** What an edit sends for an income: the entry without its id. */
  function incomeEdit(overrides: Entry = {}): Entry {
    return withRate({ type: "income", amountMinor: 50_000, currency: "RUB", clientCode: "K17", ...overrides });
  }

  function expenseEdit(overrides: Entry = {}): Entry {
    return { type: "expense", amountMinor: 10_000, currency: "RUB", category: "fuel_road", ...overrides };
  }

  async function operationOf(started: TestApp, cookie: string, id: string) {
    const body = await (await get(started, "/api/operations?from=2026-03-01&to=2026-03-31", cookie)).json();
    return (body.operations as Array<{ id: string }>).find((operation) => operation.id === id);
  }

  describe("deleting", () => {
    it("takes the operation out of the cashier's journal and out of the balance", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income({ amountMinor: 50_000 }));
      expect(await balances(started, ivan)).toEqual([
        { currency: "RUB", amountMinor: 50_000 },
        { currency: "USD", amountMinor: 0 },
      ]);

      const response = await remove(started, ivan, id);

      expect(response.status).toBe(200);
      expect(await journalIds(started, ivan)).toEqual([]);
      expect(await balances(started, ivan)).toEqual([
        { currency: "RUB", amountMinor: 0 },
        { currency: "USD", amountMinor: 0 },
      ]);
    });

    it("answers with the operation marked as deleted, by whom and when, and the new balances", async () => {
      const { started, ivan } = await desk();
      const body = income({ amountMinor: 50_000, comment: "за рейс" });
      await record(started, ivan, body);
      started.setNow(LATER);

      const response = await remove(started, ivan, body.id as string);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        operation: {
          id: body.id,
          type: "income",
          amountMinor: 50_000,
          currency: "RUB",
          rateE4: 790_000,
          usdMinor: 633,
          rateSource: "own",
          category: null,
          recipient: null,
          clientCode: "K17",
          comment: "за рейс",
          author: { login: "ivan", displayName: "Иван" },
          createdAt: NOW.toISOString(),
          shiftId: null,
          revision: 1,
          deletedAt: LATER.toISOString(),
          deletedBy: { login: "ivan", displayName: "Иван" },
        },
        balances: [
          { currency: "RUB", amountMinor: 0 },
          { currency: "USD", amountMinor: 0 },
        ],
      });
    });

    it("gives the money back when an expense is deleted", async () => {
      const { started, ivan } = await desk({ RUB: "1000" });
      const id = await record(started, ivan, expense({ amountMinor: 40_000 }));
      expect((await balances(started, ivan))[0]).toEqual({ currency: "RUB", amountMinor: 60_000 });

      await remove(started, ivan, id);

      expect((await balances(started, ivan))[0]).toEqual({ currency: "RUB", amountMinor: 100_000 });
    });

    it("leaves the other operations and the other currency alone", async () => {
      const { started, ivan } = await desk({ USD: "100" });
      const keep = await record(started, ivan, income({ amountMinor: 20_000 }));
      const gone = await record(started, ivan, income({ amountMinor: 30_000, clientCode: "K18" }));

      await remove(started, ivan, gone);

      expect(await journalIds(started, ivan)).toEqual([keep]);
      expect(await balances(started, ivan)).toEqual([
        { currency: "RUB", amountMinor: 20_000 },
        { currency: "USD", amountMinor: 10_000 },
      ]);
    });

    it("works on an operation from an earlier day", async () => {
      const { started, ivan } = await desk();
      started.setNow(new Date("2026-03-01T10:00:00Z"));
      const id = await record(started, ivan, income());
      started.setNow(NOW);

      const response = await remove(started, ivan, id);

      expect(response.status).toBe(200);
      expect(await journalIds(started, ivan, "?from=2026-03-01&to=2026-03-01")).toEqual([]);
    });

    it("is harmless to ask twice: the answer is the same and the deletion keeps its first time", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income());
      const first = await remove(started, ivan, id, "ошибся");
      started.setNow(LATER);

      const again = await remove(started, ivan, id);

      expect(again.status).toBe(200);
      expect((await again.json()).operation).toEqual((await first.json()).operation);
    });

    it("accepts a reason, and a request without any body", async () => {
      const { started, ivan } = await desk();
      const withReason = await record(started, ivan, income());
      const bare = await record(started, ivan, income({ clientCode: "K18" }));

      expect((await remove(started, ivan, withReason, "дубль")).status).toBe(200);
      expect((await remove(started, ivan, bare)).status).toBe(200);
    });

    it.each([
      ["a reason that is too long", "x".repeat(501)],
      ["a reason with a NUL character", "a\u0000b"],
      ["a reason that is not text", 42],
    ])("rejects %s and deletes nothing", async (_name, reason) => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income());

      const response = await remove(started, ivan, id, reason);

      expect(response.status).toBe(400);
      expect(await journalIds(started, ivan)).toEqual([id]);
    });

    it("rejects an unknown field in the request", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income());

      const response = await deleteRequest(started, `/api/operations/${id}`, ivan, { surprise: true });

      expect(response.status).toBe(400);
    });
  });

  describe("who may delete", () => {
    it("only the author: a colleague is refused and nothing changes", async () => {
      const { started, ivan, petr } = await desk();
      const id = await record(started, ivan, income());

      const response = await remove(started, petr, id);

      expect(response.status).toBe(403);
      expect(await journalIds(started, ivan)).toEqual([id]);
      expect((await balances(started, ivan))[0]).toEqual({ currency: "RUB", amountMinor: 50_000 });
    });

    it("never the viewer, who may only look", async () => {
      const { started, ivan, owner } = await desk();
      const id = await record(started, ivan, income());

      const response = await remove(started, owner, id);

      expect(response.status).toBe(403);
      expect(await journalIds(started, ivan)).toEqual([id]);
    });

    it("not without a login", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income());

      expect((await remove(started, undefined, id)).status).toBe(401);
    });

    it("says there is no such operation, and rejects an id that is not a uuid", async () => {
      const { started, ivan } = await desk();

      expect((await remove(started, ivan, randomUUID())).status).toBe(404);
      expect((await remove(started, ivan, "12345")).status).toBe(400);
    });
  });

  describe("the balance is no limit for a deletion", () => {
    it("deletes an income that has been spent, and the balance goes below zero", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income({ amountMinor: 50_000 }));
      await record(started, ivan, expense({ amountMinor: 30_000 }));

      const response = await remove(started, ivan, id);

      expect(response.status).toBe(200);
      expect(await journalIds(started, ivan)).toHaveLength(1);
      expect((await balances(started, ivan))[0]).toEqual({ currency: "RUB", amountMinor: -30_000 });
    });

    it("looks at the currency of the operation only", async () => {
      const { started, ivan } = await desk({ USD: "1000" });
      const rubles = await record(started, ivan, income({ amountMinor: 50_000 }));
      await record(started, ivan, expense({ amountMinor: 30_000, currency: "USD" }));

      await remove(started, ivan, rubles);

      expect(await balances(started, ivan)).toEqual([
        { currency: "RUB", amountMinor: 0 },
        { currency: "USD", amountMinor: 70_000 },
      ]);
    });
  });

  describe("editing", () => {
    it("changes an income's amount, currency, client code and comment, and the balances follow", async () => {
      const { started, ivan } = await desk();
      const body = income({ amountMinor: 50_000, comment: "было" });
      await record(started, ivan, body);
      started.setNow(LATER);

      const response = await edit(
        started,
        ivan,
        body.id as string,
        incomeEdit({ amountMinor: 75_050, currency: "USD", clientCode: "K99", comment: "стало" }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        operation: {
          id: body.id,
          type: "income",
          amountMinor: 75_050,
          currency: "USD",
          rateE4: null,
          usdMinor: 75_050,
          rateSource: null,
          category: null,
          recipient: null,
          clientCode: "K99",
          comment: "стало",
          // Who wrote it and when never change.
          author: { login: "ivan", displayName: "Иван" },
          createdAt: NOW.toISOString(),
          shiftId: null,
          revision: 1,
          deletedAt: null,
          deletedBy: null,
        },
        balances: [
          { currency: "RUB", amountMinor: 0 },
          { currency: "USD", amountMinor: 75_050 },
        ],
      });
    });

    it("changes an expense's amount, category, recipient and comment", async () => {
      const { started, ivan } = await desk({ RUB: "1000" });
      const body = expense({ amountMinor: 10_000, recipient: "Азамат" });
      await record(started, ivan, body);

      const response = await edit(
        started,
        ivan,
        body.id as string,
        expenseEdit({ amountMinor: 25_000, category: "salaries", recipient: "Бахтиёр", comment: "аванс" }),
      );

      expect(response.status).toBe(200);
      const answer = await response.json();
      expect(answer.operation).toMatchObject({
        type: "expense",
        amountMinor: 25_000,
        category: "salaries",
        recipient: "Бахтиёр",
        comment: "аванс",
        revision: 1,
      });
      expect(answer.balances[0]).toEqual({ currency: "RUB", amountMinor: 75_000 });
    });

    it("keeps the operation where it was in the journal and shows the new values there", async () => {
      const { started, ivan } = await desk();
      const first = await record(started, ivan, income({ clientCode: "K1" }));
      started.setNow(LATER);
      const second = await record(started, ivan, income({ clientCode: "K2" }));

      await edit(started, ivan, first, incomeEdit({ currency: "USD", clientCode: "K1-fixed" }));

      expect(await journalIds(started, ivan)).toEqual([second, first]);
      expect(await operationOf(started, ivan, first)).toMatchObject({ currency: "USD", clientCode: "K1-fixed" });
      expect(await journalIds(started, ivan, "?currency=USD&from=2026-03-05&to=2026-03-05")).toEqual([first]);
    });

    it("lets an expense become a client refund, once it names a client", async () => {
      const { started, ivan } = await desk({ RUB: "1000" });
      const id = await record(started, ivan, expense());

      const without = await edit(started, ivan, id, expenseEdit({ category: "client_refund" }));
      const response = await edit(started, ivan, id, expenseEdit({ category: "client_refund", clientCode: "  K5 " }));

      expect(without.status).toBe(400);
      expect(response.status).toBe(200);
      expect((await response.json()).operation).toMatchObject({ category: "client_refund", clientCode: "K5" });
    });

    it("lets a client refund become another expense, which then names no client", async () => {
      const { started, ivan } = await desk({ RUB: "1000" });
      const id = await record(started, ivan, expense({ category: "client_refund", clientCode: "K5" }));

      const stillNamed = await edit(started, ivan, id, expenseEdit({ category: "other", clientCode: "K5" }));
      const response = await edit(started, ivan, id, expenseEdit({ category: "other" }));

      expect(stillNamed.status).toBe(400);
      expect(response.status).toBe(200);
      expect((await response.json()).operation).toMatchObject({ category: "other", clientCode: null });
    });

    it("replaces the editable fields as a whole: what is not sent is cleared", async () => {
      const { started, ivan } = await desk({ RUB: "1000" });
      const id = await record(started, ivan, expense({ recipient: "Азамат", comment: "заправка" }));

      const response = await edit(started, ivan, id, expenseEdit({ amountMinor: 10_000 }));

      expect((await response.json()).operation).toMatchObject({ recipient: null, comment: null, revision: 1 });
    });

    it("trims the text and treats a blank one as none", async () => {
      const { started, ivan } = await desk({ RUB: "1000" });
      const id = await record(started, ivan, expense());

      const response = await edit(
        started,
        ivan,
        id,
        expenseEdit({ recipient: "  Азамат ", comment: "   ", amountMinor: 11_000 }),
      );

      expect((await response.json()).operation).toMatchObject({ recipient: "Азамат", comment: null });
    });

    it("counts every change: the revision grows by one each time", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income());

      const first = await edit(started, ivan, id, incomeEdit({ amountMinor: 60_000 }));
      const second = await edit(started, ivan, id, incomeEdit({ amountMinor: 70_000 }));

      expect((await first.json()).operation.revision).toBe(1);
      expect((await second.json()).operation.revision).toBe(2);
    });

    it("changes nothing when nothing is different, and is harmless to send twice", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income({ comment: "за рейс" }));

      const same = await edit(started, ivan, id, incomeEdit({ comment: "за рейс" }));
      const changed = await edit(started, ivan, id, incomeEdit({ amountMinor: 60_000 }));
      const again = await edit(started, ivan, id, incomeEdit({ amountMinor: 60_000 }));

      expect(same.status).toBe(200);
      expect((await same.json()).operation.revision).toBe(0);
      expect((await again.json()).operation.revision).toBe(1);
      expect((await changed.json()).operation.revision).toBe(1);
    });

    it("makes the suggestions of client codes follow the correction", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income({ clientCode: "TYPO-9" }));

      await edit(started, ivan, id, incomeEdit({ clientCode: "RIGHT-9" }));

      const typo = await (await get(started, "/api/client-codes?prefix=typo", ivan)).json();
      const right = await (await get(started, "/api/client-codes?prefix=right", ivan)).json();
      expect(typo).toEqual({ codes: [] });
      expect(right).toEqual({ codes: ["RIGHT-9"] });
    });
  });

  describe("what an edit refuses to accept", () => {
    const badEdits: Array<[string, "income" | "expense", Entry]> = [
      ["a zero amount", "income", { amountMinor: 0 }],
      ["a negative amount", "income", { amountMinor: -500 }],
      ["an amount with a fraction of a minor unit", "income", { amountMinor: 10.5 }],
      ["an amount above the limit", "income", { amountMinor: 10_000_001_000 }],
      ["an unknown currency", "income", { currency: "EUR" }],
      ["a blank client code", "income", { clientCode: "   " }],
      ["a missing client code", "income", { clientCode: undefined }],
      ["a category on an income", "income", { category: "other" }],
      ["a recipient on an income", "income", { recipient: "Азамат" }],
      ["an unknown field", "income", { surprise: true }],
      ["an id in the body", "income", { id: randomUUID() }],
      ["a comment that is too long", "income", { comment: "x".repeat(501) }],
      ["a comment with a NUL character", "income", { comment: "a\u0000b" }],
      ["a reason that is too long", "income", { reason: "x".repeat(501) }],
      ["a reason with a NUL character", "income", { reason: "a\u0000b" }],
      ["an unknown category", "expense", { category: "bribes" }],
      ["a missing category", "expense", { category: undefined }],
      ["a recipient that is too long", "expense", { recipient: "x".repeat(101) }],
      ["a client code on an ordinary expense", "expense", { clientCode: "K17" }],
      ["a refund without a client code", "expense", { category: "client_refund" }],
    ];

    it.each(badEdits)("%s", async (_name, kind, changes) => {
      const { started, ivan } = await desk({ RUB: "1000" });
      const id = await record(started, ivan, kind === "income" ? income() : expense());

      const response = await edit(
        started,
        ivan,
        id,
        kind === "income" ? incomeEdit(changes) : expenseEdit(changes),
      );

      expect(response.status).toBe(400);
      expect((await operationOf(started, ivan, id))).toMatchObject({ revision: 0 });
    });

    it("an edit that says the operation is of the other kind", async () => {
      const { started, ivan } = await desk({ RUB: "1000" });
      const incomeId = await record(started, ivan, income());
      const expenseId = await record(started, ivan, expense());

      const asExpense = await edit(started, ivan, incomeId, expenseEdit());
      const asIncome = await edit(started, ivan, expenseId, incomeEdit());

      expect(asExpense.status).toBe(409);
      expect(await asExpense.json()).toEqual({ error: "type_cannot_change" });
      expect(asIncome.status).toBe(409);
    });
  });

  describe("who may edit", () => {
    it("only the author: a colleague is refused and nothing changes", async () => {
      const { started, ivan, petr } = await desk();
      const id = await record(started, ivan, income());

      const response = await edit(started, petr, id, incomeEdit({ amountMinor: 1 }));

      expect(response.status).toBe(403);
      expect(await operationOf(started, ivan, id)).toMatchObject({ amountMinor: 50_000, revision: 0 });
    });

    it("never the viewer", async () => {
      const { started, ivan, owner } = await desk();
      const id = await record(started, ivan, income());

      const valid = await edit(started, owner, id, incomeEdit({ amountMinor: 1 }));
      const nonsense = await edit(started, owner, id, { nonsense: true });

      expect(valid.status).toBe(403);
      expect(nonsense.status).toBe(403);
      expect(await operationOf(started, ivan, id)).toMatchObject({ amountMinor: 50_000 });
    });

    it("not without a login", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income());

      expect((await edit(started, undefined, id, incomeEdit())).status).toBe(401);
    });

    it("says there is no such operation, and rejects an id that is not a uuid", async () => {
      const { started, ivan } = await desk();

      expect((await edit(started, ivan, randomUUID(), incomeEdit())).status).toBe(404);
      expect((await edit(started, ivan, "12345", incomeEdit())).status).toBe(400);
    });

    it("not once the operation is deleted", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income());
      await remove(started, ivan, id);

      const response = await edit(started, ivan, id, incomeEdit({ amountMinor: 1 }));

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "operation_deleted" });
    });
  });

  describe("the balance is no limit for an edit either", () => {
    it("raises an expense above what the cash desk holds, and the balance goes below zero", async () => {
      const { started, ivan } = await desk();
      await record(started, ivan, income({ amountMinor: 50_000 }));
      const id = await record(started, ivan, expense({ amountMinor: 20_000 }));

      const response = await edit(started, ivan, id, expenseEdit({ amountMinor: 90_000 }));

      expect(response.status).toBe(200);
      expect((await balances(started, ivan))[0]).toEqual({ currency: "RUB", amountMinor: -40_000 });
      expect(await operationOf(started, ivan, id)).toMatchObject({ amountMinor: 90_000, revision: 1 });
    });

    it("lowers an income below what has already been spent", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income({ amountMinor: 50_000 }));
      await record(started, ivan, expense({ amountMinor: 40_000 }));

      const response = await edit(started, ivan, id, incomeEdit({ amountMinor: 10_000 }));

      expect(response.status).toBe(200);
      expect((await balances(started, ivan))[0]).toEqual({ currency: "RUB", amountMinor: -30_000 });
    });

    it("moves a spent income to another currency: the first goes below zero, the other grows", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income({ amountMinor: 50_000 }));
      await record(started, ivan, expense({ amountMinor: 30_000 }));

      const response = await edit(started, ivan, id, incomeEdit({ amountMinor: 50_000, currency: "USD" }));

      expect(response.status).toBe(200);
      expect(await balances(started, ivan)).toEqual([
        { currency: "RUB", amountMinor: -30_000 },
        { currency: "USD", amountMinor: 50_000 },
      ]);
    });
  });

  describe("sending the original entry again after it was corrected", () => {
    it("answers 200 with the operation as it is now, and does not undo the correction", async () => {
      const { started, ivan } = await desk();
      const body = income({ amountMinor: 50_000 });
      await record(started, ivan, body);
      await edit(started, ivan, body.id as string, incomeEdit({ amountMinor: 70_000 }));

      const again = await postJson(started, "/api/operations", body, ivan);

      expect(again.status).toBe(200);
      const answer = await again.json();
      expect(answer.operation).toMatchObject({ amountMinor: 70_000, revision: 1 });
      expect(answer.balances[0]).toEqual({ currency: "RUB", amountMinor: 70_000 });
    });

    it("answers 200 with the operation marked as deleted, when it was deleted since", async () => {
      const { started, ivan } = await desk();
      const body = income();
      await record(started, ivan, body);
      await remove(started, ivan, body.id as string);

      const again = await postJson(started, "/api/operations", body, ivan);

      expect(again.status).toBe(200);
      expect((await again.json()).operation).toMatchObject({ deletedAt: NOW.toISOString(), revision: 1 });
      expect(await journalIds(started, ivan)).toEqual([]);
    });

    it("still refuses the same id for a different entry, also one that matches the corrected values", async () => {
      const { started, ivan, petr } = await desk();
      const body = income({ amountMinor: 50_000 });
      await record(started, ivan, body);
      await edit(started, ivan, body.id as string, incomeEdit({ amountMinor: 70_000 }));

      const corrected = await postJson(started, "/api/operations", { ...body, amountMinor: 70_000 }, ivan);
      const other = await postJson(started, "/api/operations", { ...body, amountMinor: 1 }, ivan);
      const colleague = await postJson(started, "/api/operations", body, petr);

      expect(corrected.status).toBe(409);
      expect(other.status).toBe(409);
      expect(colleague.status).toBe(409);
    });
  });

  describe("the history of an operation, for the viewer", () => {
    const historyOf = (started: TestApp, cookie: string | undefined, id: string) =>
      get(started, `/api/operations/${id}/history`, cookie);

    const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

    it("of an operation nobody touched: who wrote it, when, what it says, and no changes", async () => {
      const { started, ivan, owner } = await desk();
      const body = income({ amountMinor: 50_000, comment: "за рейс" });
      await record(started, ivan, body);

      const response = await historyOf(started, owner, body.id as string);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        operation: expect.objectContaining({ id: body.id, revision: 0, deletedAt: null }),
        created: {
          at: NOW.toISOString(),
          by: { login: "ivan", displayName: "Иван" },
          state: {
            amountMinor: 50_000,
            currency: "RUB",
            rateE4: 790_000,
            category: null,
            recipient: null,
            clientCode: "K17",
            comment: "за рейс",
          },
        },
        changes: [],
      });
    });

    it("keeps every version: who changed what, when, why, and what it was before and became", async () => {
      const { started, ivan, owner } = await desk({ RUB: "1000" });
      const body = expense({ amountMinor: 10_000, category: "fuel_road", recipient: "Азамат", comment: "заправка" });
      await record(started, ivan, body);
      const id = body.id as string;

      started.setNow(at(10));
      await edit(started, ivan, id, expenseEdit({ amountMinor: 12_000, category: "fuel_road", recipient: "Азамат", comment: "заправка", reason: "опечатка в сумме" }));
      started.setNow(at(20));
      await edit(started, ivan, id, expenseEdit({ amountMinor: 12_000, category: "salaries", recipient: "Бахтиёр" }));
      started.setNow(at(30));
      await remove(started, ivan, id, "это был не расход");

      const answer = await (await historyOf(started, owner, id)).json();

      const original = { amountMinor: 10_000, currency: "RUB", rateE4: null, category: "fuel_road", recipient: "Азамат", clientCode: null, comment: "заправка" };
      const afterFirst = { ...original, amountMinor: 12_000 };
      const afterSecond = { amountMinor: 12_000, currency: "RUB", rateE4: null, category: "salaries", recipient: "Бахтиёр", clientCode: null, comment: null };
      expect(answer.created).toEqual({ at: NOW.toISOString(), by: { login: "ivan", displayName: "Иван" }, state: original });
      expect(answer.changes).toEqual([
        { revision: 1, action: "edit", at: at(10).toISOString(), by: { login: "ivan", displayName: "Иван" }, reason: "опечатка в сумме", before: original, after: afterFirst },
        { revision: 2, action: "edit", at: at(20).toISOString(), by: { login: "ivan", displayName: "Иван" }, reason: null, before: afterFirst, after: afterSecond },
        { revision: 3, action: "delete", at: at(30).toISOString(), by: { login: "ivan", displayName: "Иван" }, reason: "это был не расход", before: afterSecond, after: afterSecond },
      ]);
      expect(answer.operation).toMatchObject({
        revision: 3,
        deletedAt: at(30).toISOString(),
        deletedBy: { login: "ivan", displayName: "Иван" },
        amountMinor: 12_000,
        category: "salaries",
      });
    });

    it("keeps nothing for what changed nothing, and nothing for what was refused", async () => {
      const { started, ivan, owner } = await desk();
      const id = await record(started, ivan, income({ amountMinor: 50_000 }));
      await record(started, ivan, expense({ amountMinor: 30_000 }));

      await edit(started, ivan, id, incomeEdit({ amountMinor: 50_000 }));       // the same values
      expect((await edit(started, ivan, id, { nonsense: true })).status).toBe(400);

      const answer = await (await historyOf(started, owner, id)).json();
      expect(answer.changes).toEqual([]);
      expect(answer.operation.revision).toBe(0);
    });

    it("is written once however often a deletion is asked for", async () => {
      const { started, ivan, owner } = await desk();
      const id = await record(started, ivan, income());
      await remove(started, ivan, id, "ошибка");
      await remove(started, ivan, id, "ещё раз");
      await remove(started, ivan, id);

      const answer = await (await historyOf(started, owner, id)).json();

      expect(answer.changes).toHaveLength(1);
      expect(answer.changes[0]).toMatchObject({ action: "delete", reason: "ошибка" });
    });

    it("treats a blank reason as no reason, and trims a real one", async () => {
      const { started, ivan, owner } = await desk();
      const first = await record(started, ivan, income());
      const second = await record(started, ivan, income({ clientCode: "K18" }));

      await edit(started, ivan, first, incomeEdit({ amountMinor: 60_000, reason: "   " }));
      await remove(started, ivan, second, "  дубль  ");

      expect((await (await historyOf(started, owner, first)).json()).changes[0].reason).toBeNull();
      expect((await (await historyOf(started, owner, second)).json()).changes[0].reason).toBe("дубль");
    });

    it("shows the history of an operation a cashier can no longer see", async () => {
      const { started, ivan, owner } = await desk();
      const id = await record(started, ivan, income());
      await remove(started, ivan, id);

      expect(await journalIds(started, ivan)).toEqual([]);
      expect((await historyOf(started, owner, id)).status).toBe(200);
    });

    it("is for the viewer only: a cashier, even the author, is refused", async () => {
      const { started, ivan, petr } = await desk();
      const id = await record(started, ivan, income());

      expect((await historyOf(started, ivan, id)).status).toBe(403);
      expect((await historyOf(started, petr, id)).status).toBe(403);
      expect((await historyOf(started, undefined, id)).status).toBe(401);
    });

    it("says there is no such operation, and rejects an id that is not a uuid", async () => {
      const { started, owner } = await desk();

      expect((await historyOf(started, owner, randomUUID())).status).toBe(404);
      expect((await historyOf(started, owner, "12345")).status).toBe(400);
    });
  });

  describe("deleted operations in the journal", () => {
    async function oneDeleted() {
      const context = await desk();
      const { started, ivan } = context;
      const kept = await record(started, ivan, income({ clientCode: "KEEP" }));
      started.setNow(LATER);
      const gone = await record(started, ivan, income({ clientCode: "GONE" }));
      started.setNow(new Date(LATER.getTime() + 60_000));
      await remove(started, ivan, gone, "дубль");
      return { ...context, kept, gone };
    }

    it("are left out for everybody by default", async () => {
      const { started, ivan, owner, kept } = await oneDeleted();

      expect(await journalIds(started, ivan)).toEqual([kept]);
      expect(await journalIds(started, owner)).toEqual([kept]);
      expect(await journalIds(started, owner, "?deleted=exclude")).toEqual([kept]);
    });

    it("are shown to the viewer among the others, marked, when asked for", async () => {
      const { started, owner, kept, gone } = await oneDeleted();

      const body = await (await get(started, "/api/operations?deleted=include", owner)).json();

      expect(body.operations.map((operation: { id: string }) => operation.id)).toEqual([gone, kept]);
      expect(body.operations[0]).toMatchObject({
        id: gone,
        revision: 1,
        deletedAt: new Date(LATER.getTime() + 60_000).toISOString(),
        deletedBy: { login: "ivan", displayName: "Иван" },
      });
      expect(body.operations[1]).toMatchObject({ id: kept, revision: 0, deletedAt: null, deletedBy: null });
    });

    it("are the only ones shown to the viewer when asked for", async () => {
      const { started, owner, gone } = await oneDeleted();

      expect(await journalIds(started, owner, "?deleted=only")).toEqual([gone]);
    });

    it("combine with the other filters", async () => {
      const { started, owner, gone } = await oneDeleted();

      expect(await journalIds(started, owner, "?deleted=only&clientCode=gone&type=income&author=ivan")).toEqual([gone]);
      expect(await journalIds(started, owner, "?deleted=only&clientCode=keep")).toEqual([]);
    });

    it("stay hidden from a cashier, who is refused when asking for them", async () => {
      const { started, ivan } = await oneDeleted();

      expect((await get(started, "/api/operations?deleted=include", ivan)).status).toBe(403);
      expect((await get(started, "/api/operations?deleted=only", ivan)).status).toBe(403);
      expect((await get(started, "/api/operations?deleted=exclude", ivan)).status).toBe(200);
    });

    it("are an unknown choice for anything else", async () => {
      const { started, owner } = await oneDeleted();

      expect((await get(started, "/api/operations?deleted=yes", owner)).status).toBe(400);
    });

    it("count for nothing in the balance, whatever the viewer chooses to look at", async () => {
      const { started, owner } = await oneDeleted();

      await get(started, "/api/operations?deleted=include", owner);

      expect((await balances(started, owner))[0]).toEqual({ currency: "RUB", amountMinor: 50_000 });
    });
  });

  describe("what the database itself guarantees", () => {
    it("keeps a deleted operation and its history in the tables", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income({ amountMinor: 50_000 }));
      await remove(started, ivan, id, "ошибся");

      const operations = await started.query<{ amount_minor: string; deleted_at: Date | null; revision: number }>(
        "SELECT amount_minor, deleted_at, revision FROM operations WHERE id = $1",
        [id],
      );
      const changes = await started.query<{ action: string; reason: string | null }>(
        "SELECT action, reason FROM operation_changes WHERE operation_id = $1",
        [id],
      );

      expect(operations).toHaveLength(1);
      expect(operations[0]).toMatchObject({ amount_minor: "50000", revision: 1 });
      expect(operations[0]!.deleted_at).not.toBeNull();
      expect(changes).toEqual([{ action: "delete", reason: "ошибся" }]);
    });

    it("writes one line of history for every change, numbered one after another", async () => {
      const { started, ivan } = await desk({ RUB: "1000" });
      const id = await record(started, ivan, expense({ amountMinor: 10_000 }));
      await edit(started, ivan, id, expenseEdit({ amountMinor: 11_000 }));
      await edit(started, ivan, id, expenseEdit({ amountMinor: 12_000 }));
      await edit(started, ivan, id, expenseEdit({ amountMinor: 12_000, comment: "x" }));
      await remove(started, ivan, id);

      const lines = await started.query<{ revision: number; action: string }>(
        "SELECT revision, action FROM operation_changes WHERE operation_id = $1 ORDER BY id",
        [id],
      );

      expect(lines).toEqual([
        { revision: 1, action: "edit" },
        { revision: 2, action: "edit" },
        { revision: 3, action: "edit" },
        { revision: 4, action: "delete" },
      ]);
    });

    it("refuses to delete an operation or empty the table, whoever asks", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income());

      await expect(started.execute("DELETE FROM operations WHERE id = $1", [id])).rejects.toThrow(/never deleted/);
      await expect(started.execute("TRUNCATE operations CASCADE")).rejects.toThrow(/never deleted/);
      expect(await journalIds(started, ivan)).toEqual([id]);
    });

    it("refuses to change or remove a line of history", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income());
      await remove(started, ivan, id);

      await expect(started.execute("UPDATE operation_changes SET reason = 'nothing happened'")).rejects.toThrow(/only grow/);
      await expect(started.execute("DELETE FROM operation_changes")).rejects.toThrow(/only grow/);
      await expect(started.execute("TRUNCATE operation_changes")).rejects.toThrow(/only grow/);
    });

    it("refuses to change what an operation says without a new revision and a line of history", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income({ amountMinor: 50_000 }));

      await expect(started.execute("UPDATE operations SET amount_minor = 1 WHERE id = $1", [id])).rejects.toThrow(
        /next revision/,
      );
      // A new revision with nothing written in the history is refused when the transaction ends.
      await expect(
        started.execute("UPDATE operations SET amount_minor = 1, revision = revision + 1 WHERE id = $1", [id]),
      ).rejects.toThrow(/no line in its history/);
      expect(await operationOf(started, ivan, id)).toMatchObject({ amountMinor: 50_000, revision: 0 });
    });

    it("refuses to skip revisions or to move one without a change", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income());

      await expect(
        started.execute("UPDATE operations SET amount_minor = 1, revision = revision + 2 WHERE id = $1", [id]),
      ).rejects.toThrow(/next revision/);
      await expect(started.execute("UPDATE operations SET revision = revision + 1 WHERE id = $1", [id])).rejects.toThrow(
        /only with a change/,
      );
    });

    it("refuses a line of history for a revision the operation never reached", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income());

      await expect(
        started.execute(
          `INSERT INTO operation_changes (operation_id, revision, action, changed_at, changed_by, state_before)
           SELECT $1, 1, 'edit', now(), author_id, '{}' FROM operations WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/never reached/);
    });

    it("refuses to change who wrote an operation, when, or what kind it is", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income());

      await expect(
        started.execute("UPDATE operations SET author_id = (SELECT id FROM users WHERE login = 'petr') WHERE id = $1", [id]),
      ).rejects.toThrow(/never change/);
      await expect(started.execute("UPDATE operations SET created_at = now() WHERE id = $1", [id])).rejects.toThrow(/never change/);
    });

    it("refuses to change a deleted operation at all", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income());
      await remove(started, ivan, id);

      await expect(
        started.execute("UPDATE operations SET comment = 'edited later', revision = revision + 1 WHERE id = $1", [id]),
      ).rejects.toThrow(/final/);
      await expect(
        started.execute("UPDATE operations SET deleted_at = NULL, deleted_by = NULL, revision = revision + 1 WHERE id = $1", [id]),
      ).rejects.toThrow(/final/);
    });

    it("does allow a change that comes with its line of history, in either order", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income({ amountMinor: 50_000 }));

      // The line has to say what the operation was before: the database checks it.
      await started.execute(`
        BEGIN;
        INSERT INTO operation_changes (operation_id, revision, action, changed_at, changed_by, state_before)
          SELECT id, 1, 'edit', now(), author_id,
                 jsonb_build_object('amountMinor', amount_minor, 'currency', currency, 'rateE4', rate_e4, 'category', category,
                                    'recipient', recipient, 'clientCode', client_code, 'comment', comment)
            FROM operations WHERE id = '${id}';
        UPDATE operations SET amount_minor = 60000, revision = 1 WHERE id = '${id}';
        COMMIT;
      `);

      expect(await operationOf(started, ivan, id)).toMatchObject({ amountMinor: 60_000, revision: 1 });
    });
  });

  describe("what a deleted operation no longer affects", () => {
    it("is not offered any more as a client code", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income({ clientCode: "TYPO-1" }));
      await record(started, ivan, income({ clientCode: "K17" }));

      await remove(started, ivan, id);

      const suggestions = await (await get(started, "/api/client-codes?prefix=", ivan)).json();
      expect(suggestions).toEqual({ codes: ["K17"] });
    });

    it("no longer decides which currency the form starts with", async () => {
      const { started, ivan } = await desk({ USD: "100" });
      await record(started, ivan, income({ currency: "RUB" }));
      started.setNow(LATER);
      const dollars = await record(started, ivan, expense({ currency: "USD", amountMinor: 100 }));
      expect(await (await get(started, "/api/operations/defaults", ivan)).json()).toEqual({ currency: "USD" });

      await remove(started, ivan, dollars);

      expect(await (await get(started, "/api/operations/defaults", ivan)).json()).toEqual({ currency: "RUB" });
    });
  });
});
