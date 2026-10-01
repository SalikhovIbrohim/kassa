import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { deleteRequest, get, loginAs, postJson, putJson } from "./helpers/http.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

// 11:30 in Moscow (UTC+3), the middle of 5 March.
const NOW = new Date("2026-03-05T08:30:00Z");
const LATER = new Date("2026-03-05T09:00:00Z");

type Entry = Record<string, unknown>;
type Balance = { currency: string; amountMinor: number };

/**
 * The finer points of correcting and deleting, which an independent review of the first
 * version found missing or wrong. Kept apart from corrections.test.ts so that each test says
 * which hole it closes (and so that the two files run side by side).
 */
describe("correcting and deleting: the guarantees at the edges", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function desk(opening: { RUB?: string; USD?: string } = {}) {
    const started = await startTestApp();
    started.setNow(NOW);
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier", displayName: "Иван" });
    await started.admin.createUser({ login: "petr", password: "another good one", role: "cashier", displayName: "Пётр" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer", displayName: "Владелец" });
    for (const [currency, amount] of Object.entries(opening)) await started.admin.setOpeningBalance(currency, amount);
    app = started;
    return {
      started,
      ivan: await loginAs(started, "ivan", "correct horse"),
      petr: await loginAs(started, "petr", "another good one"),
      owner: await loginAs(started, "owner", "long enough pass"),
    };
  }

  const income = (o: Entry = {}): Entry => ({ id: randomUUID(), type: "income", amountMinor: 50_000, currency: "RUB", clientCode: "K17", ...o });
  const expense = (o: Entry = {}): Entry => ({ id: randomUUID(), type: "expense", amountMinor: 10_000, currency: "RUB", category: "fuel_road", ...o });
  const incomeEdit = (o: Entry = {}): Entry => ({ type: "income", amountMinor: 50_000, currency: "RUB", clientCode: "K17", ...o });
  const expenseEdit = (o: Entry = {}): Entry => ({ type: "expense", amountMinor: 10_000, currency: "RUB", category: "fuel_road", ...o });

  async function record(started: TestApp, cookie: string, body: Entry): Promise<string> {
    const response = await postJson(started, "/api/operations", body, cookie);
    expect(response.status, await response.clone().text()).toBe(201);
    return body.id as string;
  }

  const edit = (started: TestApp, cookie: string | undefined, id: string, body: unknown) =>
    putJson(started, `/api/operations/${id}`, body, cookie);
  const remove = (started: TestApp, cookie: string | undefined, id: string, body?: unknown) =>
    deleteRequest(started, `/api/operations/${id}`, cookie, body);
  const historyOf = async (started: TestApp, cookie: string, id: string) =>
    (await get(started, `/api/operations/${id}/history`, cookie)).json();
  const balances = async (started: TestApp, cookie: string) =>
    (await (await get(started, "/api/balances", cookie)).json()).balances as Balance[];

  /**
   * Makes every write that matches `when` hold its transaction open for a second, after it has
   * taken its locks and made its checks: a way to have a request in flight while another one
   * arrives, without guessing at timing.
   */
  async function slowDown(started: TestApp, event: "INSERT" | "UPDATE", when: string) {
    await started.execute(`
      CREATE FUNCTION slow_down() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(1); RETURN NEW; END
      $$;
      CREATE TRIGGER slow_down BEFORE ${event} ON operations
        FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION slow_down();
    `);
  }

  /** Resolves when a write slowed down by `slowDown` is in its pause. */
  async function untilSlowedDown(started: TestApp) {
    for (let attempt = 0; attempt < 500; attempt++) {
      const sleeping = await started.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'PgSleep'",
      );
      if (sleeping.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("No write is waiting in its pause");
  }

  /** Resolves when some request is queued for a balance lock that another one holds. */
  async function untilQueued(started: TestApp) {
    for (let attempt = 0; attempt < 500; attempt++) {
      const queued = await started.query(
        `SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      );
      if (queued.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("No request is queued for a lock");
  }

  describe("who is told what", () => {
    it("a colleague learns nothing about somebody else's operation, whatever state it is in", async () => {
      const { started, ivan, petr } = await desk();
      const gone = await record(started, ivan, income());
      await remove(started, ivan, gone);
      const live = await record(started, ivan, income({ clientCode: "K18" }));

      const putGone = await edit(started, petr, gone, incomeEdit());
      const delGone = await remove(started, petr, gone);
      const wrongType = await edit(started, petr, live, expenseEdit());

      expect([putGone.status, delGone.status, wrongType.status]).toEqual([403, 403, 403]);
      expect(await delGone.json()).toEqual({ error: "forbidden" });
    });

    it("the viewer is turned away before the id or the body is looked at, on DELETE as on PUT", async () => {
      const { started, owner } = await desk();

      expect((await remove(started, owner, "12345")).status).toBe(403);
      expect((await remove(started, owner, randomUUID(), { surprise: true })).status).toBe(403);
    });
  });

  describe("what a correction saves", () => {
    it("a change of the category alone, and of the recipient alone", async () => {
      const { started, ivan } = await desk({ RUB: "1000" });
      const id = await record(started, ivan, expense({ recipient: "Азамат" }));

      const category = await edit(started, ivan, id, expenseEdit({ category: "salaries", recipient: "Азамат" }));
      const recipient = await edit(started, ivan, id, expenseEdit({ category: "salaries", recipient: "Бахтиёр" }));

      expect((await category.json()).operation).toMatchObject({ category: "salaries", revision: 1 });
      expect((await recipient.json()).operation).toMatchObject({ recipient: "Бахтиёр", revision: 2 });
    });

    it("an edit without a type is a 400, whichever kind of operation it is", async () => {
      const { started, ivan } = await desk({ RUB: "1000" });
      const inc = await record(started, ivan, income());
      const exp = await record(started, ivan, expense());

      const incomeLike = await edit(started, ivan, inc, { amountMinor: 60_000, currency: "RUB", clientCode: "K17" });
      const expenseLike = await edit(started, ivan, exp, { amountMinor: 20_000, currency: "RUB", category: "fuel_road" });

      expect([incomeLike.status, expenseLike.status]).toEqual([400, 400]);
    });

    it("keeps a reason of exactly 500 characters, on PUT and on DELETE; trims a real one; a blank one is none", async () => {
      const { started, ivan, owner } = await desk();
      const a = await record(started, ivan, income());
      const b = await record(started, ivan, income({ clientCode: "K18" }));
      const c = await record(started, ivan, income({ clientCode: "K19" }));
      const d = await record(started, ivan, income({ clientCode: "K20" }));
      const reason = "я".repeat(500);

      const edited = await edit(started, ivan, a, incomeEdit({ amountMinor: 60_000, reason }));
      const deleted = await remove(started, ivan, b, { reason });
      await edit(started, ivan, c, incomeEdit({ amountMinor: 60_000, clientCode: "K19", reason: "  опечатка  " }));
      await remove(started, ivan, d, { reason: "   " });

      expect([edited.status, deleted.status]).toEqual([200, 200]);
      expect((await historyOf(started, owner, a)).changes[0].reason).toBe(reason);
      expect((await historyOf(started, owner, b)).changes[0].reason).toBe(reason);
      expect((await historyOf(started, owner, c)).changes[0].reason).toBe("опечатка");
      expect((await historyOf(started, owner, d)).changes[0].reason).toBeNull();
    });

    it("answers a change that changes nothing, and a repeated deletion, with the balances as they are", async () => {
      const { started, ivan } = await desk({ RUB: "1000" });
      const gone = await record(started, ivan, income({ amountMinor: 50_000 }));
      const kept = income({ amountMinor: 20_000, clientCode: "K2" });
      await record(started, ivan, kept);

      const same = await edit(started, ivan, kept.id as string, incomeEdit({ amountMinor: 20_000, clientCode: "K2" }));
      expect((await same.json()).balances).toEqual([
        { currency: "RUB", amountMinor: 170_000 },
        { currency: "USD", amountMinor: 0 },
      ]);

      await remove(started, ivan, gone);
      const again = await remove(started, ivan, gone);
      expect((await again.json()).balances).toEqual([
        { currency: "RUB", amountMinor: 120_000 },
        { currency: "USD", amountMinor: 0 },
      ]);
    });

    it("allows a correction that does not touch the money while the balance is below zero", async () => {
      const { started, ivan } = await desk({ RUB: "1000" });
      const id = await record(started, ivan, expense({ amountMinor: 80_000 }));
      // The developer lowers the opening balance: 100 - 800 = -700.
      await started.admin.setOpeningBalance("RUB", "100");

      const fix = await edit(started, ivan, id, expenseEdit({ amountMinor: 80_000, comment: "уточнение" }));

      expect(fix.status).toBe(200);
      expect((await fix.json()).balances[0]).toEqual({ currency: "RUB", amountMinor: -70_000 });
    });

    it("keeps text as it will be read back: a half of a surrogate pair is replaced at once, so a repeat is no change", async () => {
      const { started, ivan } = await desk();
      const body = income({ comment: "a\ud800b" });
      const id = await record(started, ivan, body);

      const same = await edit(started, ivan, id, incomeEdit({ comment: "a\ud800b" }));
      const replay = await postJson(started, "/api/operations", body, ivan);

      expect(same.status).toBe(200);
      expect((await same.json()).operation).toMatchObject({ comment: "a\uFFFDb", revision: 0 });
      expect(replay.status).toBe(200);
    });

    it("does not take a pair of surrogates in the right order for a broken one", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income({ comment: "корабль \u{1F6A2}" }));

      const same = await edit(started, ivan, id, incomeEdit({ comment: "корабль \u{1F6A2}" }));

      expect((await same.json()).operation).toMatchObject({ comment: "корабль \u{1F6A2}", revision: 0 });
    });
  });

  describe("ids", () => {
    it("an id that only the JSON schema library takes for a uuid is a 400, not a 500", async () => {
      const { started, ivan, owner } = await desk();
      const id = await record(started, ivan, income());
      const urn = `urn:uuid:${id}`;

      expect({
        put: (await edit(started, ivan, urn, incomeEdit())).status,
        del: (await remove(started, ivan, urn)).status,
        history: (await get(started, `/api/operations/${urn}/history`, owner)).status,
        post: (await postJson(started, "/api/operations", { ...income(), id: `urn:uuid:${randomUUID()}` }, ivan)).status,
      }).toEqual({ put: 400, del: 400, history: 400, post: 400 });
    });

    it("an upper-case uuid is the same operation", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income());

      expect((await remove(started, ivan, id.toUpperCase())).status).toBe(200);
    });
  });

  describe("what the request may carry", () => {
    /** A request with a JSON content type and a body of zero bytes, which `fetch` does not always send. */
    function sendEmptyJson(started: TestApp, method: string, path: string, cookie: string): Promise<number> {
      return new Promise((resolve, reject) => {
        const request = httpRequest(
          `${started.baseUrl}${path}`,
          { method, headers: { cookie, "content-type": "application/json", "content-length": "0" } },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode ?? 0));
          },
        );
        request.on("error", reject);
        request.end();
      });
    }

    it("a deletion needs no body, whatever the Content-Type says", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income());

      expect(await sendEmptyJson(started, "DELETE", `/api/operations/${id}`, ivan)).toBe(200);
    });

    it("an empty body is still not an entry: POST and PUT refuse it", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income());

      expect(await sendEmptyJson(started, "POST", "/api/operations", ivan)).toBe(400);
      expect(await sendEmptyJson(started, "PUT", `/api/operations/${id}`, ivan)).toBe(400);
    });

    it("a reason sent in the query string is refused, not quietly dropped", async () => {
      const { started, ivan, owner } = await desk();
      const id = await record(started, ivan, income());
      const send = (method: string, path: string, cookie: string) =>
        fetch(`${started.baseUrl}${path}`, {
          method,
          headers: { cookie, ...(method === "PUT" ? { "content-type": "application/json" } : {}) },
          body: method === "PUT" ? JSON.stringify(incomeEdit({ amountMinor: 60_000 })) : undefined,
        });

      expect({
        del: (await send("DELETE", `/api/operations/${id}?reason=duplicate`, ivan)).status,
        put: (await send("PUT", `/api/operations/${id}?reason=duplicate`, ivan)).status,
        history: (await send("GET", `/api/operations/${id}/history?x=1`, owner)).status,
      }).toEqual({ del: 400, put: 400, history: 400 });
      // Nothing was changed by the refused requests.
      expect((await historyOf(started, owner, id)).changes).toEqual([]);
    });
  });

  describe("the order of what happens to one operation", () => {
    it("twelve corrections at once all succeed, and the history numbers them one after another", async () => {
      const { started, ivan, owner } = await desk();
      const id = await record(started, ivan, income({ amountMinor: 1_000 }));

      const answers = await Promise.all(
        Array.from({ length: 12 }, (_, i) => edit(started, ivan, id, incomeEdit({ amountMinor: 2_000 + i }))),
      );

      expect(answers.map((response) => response.status)).toEqual(Array(12).fill(200));
      const { changes, operation } = await historyOf(started, owner, id);
      expect(changes.map((change: { revision: number }) => change.revision)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      expect(changes[0].before.amountMinor).toBe(1_000);
      changes.forEach((change: { after: { amountMinor: number } }, i: number) => {
        expect(change.after.amountMinor).toBe(changes[i + 1]?.before.amountMinor ?? operation.amountMinor);
      });
    });

    it("never shows a history that is out of step with the operation while corrections keep arriving", async () => {
      const { started, ivan, owner } = await desk();
      const id = await record(started, ivan, income({ amountMinor: 1_000 }));

      let finished = false;
      const writer = (async () => {
        for (let i = 0; i < 12; i++) {
          await Promise.all([
            edit(started, ivan, id, incomeEdit({ amountMinor: 2_000 + i })),
            edit(started, ivan, id, incomeEdit({ amountMinor: 5_000 + i, clientCode: "K2" })),
          ]);
        }
        await remove(started, ivan, id);
        finished = true;
      })();
      let torn = 0;
      let reads = 0;
      const reader = (async () => {
        while (!finished) {
          const histories = await Promise.all(Array.from({ length: 6 }, () => historyOf(started, owner, id)));
          for (const history of histories) {
            reads++;
            const last = history.changes.at(-1);
            // The operation says what the last change says it became, and has as many changes as its revision.
            const outOfStep =
              history.operation.revision !== history.changes.length ||
              (last !== undefined && last.after.amountMinor !== history.operation.amountMinor);
            if (outOfStep) torn++;
          }
        }
      })();
      await writer;
      await reader;

      expect(reads).toBeGreaterThan(0);
      expect(torn).toBe(0);
    }, 60_000);

    it("answers the original entry sent again with 200 after several corrections, and after corrections and a deletion", async () => {
      const { started, ivan } = await desk();
      const first = income({ amountMinor: 50_000 });
      const second = income({ amountMinor: 40_000, clientCode: "K18" });
      await record(started, ivan, first);
      await record(started, ivan, second);
      await edit(started, ivan, first.id as string, incomeEdit({ amountMinor: 60_000 }));
      await edit(started, ivan, first.id as string, incomeEdit({ amountMinor: 70_000, comment: "потом" }));
      await edit(started, ivan, second.id as string, incomeEdit({ amountMinor: 45_000, clientCode: "K18" }));
      await remove(started, ivan, second.id as string);

      const afterTwo = await postJson(started, "/api/operations", first, ivan);
      const afterDelete = await postJson(started, "/api/operations", second, ivan);
      const middleVersion = await postJson(started, "/api/operations", { ...first, amountMinor: 60_000 }, ivan);

      expect(afterTwo.status).toBe(200);
      expect((await afterTwo.json()).operation).toMatchObject({ amountMinor: 70_000, revision: 2 });
      expect(afterDelete.status).toBe(200);
      expect((await afterDelete.json()).operation).toMatchObject({ revision: 2, deletedAt: NOW.toISOString() });
      // A version in the middle of the story is not the entry that was sent.
      expect(middleVersion.status).toBe(409);
    });

    it("answers a retry of an income from one moment, even while the income is being deleted", async () => {
      const { started, ivan } = await desk();
      const torn: Array<{ live: boolean; rub: number }> = [];

      for (let round = 0; round < 10; round++) {
        const body = income({ amountMinor: 50_000, clientCode: `Z${round}` });
        await record(started, ivan, body);
        const answers = await Promise.all(
          Array.from({ length: 40 }, (_, i) =>
            i === 20
              ? remove(started, ivan, body.id as string).then(() => undefined)
              : postJson(started, "/api/operations", body, ivan).then((response) => response.json()),
          ),
        );
        for (const answer of answers) {
          if (!answer) continue;
          // Either the income is there and counts, or it is deleted and does not: never half and half.
          const live = answer.operation.deletedAt === null;
          const rub = (answer.balances as Balance[]).find((balance) => balance.currency === "RUB")!.amountMinor;
          if (live !== (rub === 50_000)) torn.push({ live, rub });
        }
      }

      expect(torn).toEqual([]);
    }, 60_000);
  });

  describe("the locks", () => {
    it("dates a change by the moment it got its turn, not the moment it was asked for", async () => {
      const { started, ivan, owner } = await desk();
      const id = await record(started, ivan, income({ amountMinor: 1_000 }));
      await slowDown(started, "UPDATE", "NEW.revision = 1");
      const first = edit(started, ivan, id, incomeEdit({ amountMinor: 2_000 }));
      await untilSlowedDown(started);
      const second = edit(started, ivan, id, incomeEdit({ amountMinor: 3_000 }));
      await untilQueued(started);
      started.setNow(LATER);

      await Promise.all([first, second]);

      const { changes } = await historyOf(started, owner, id);
      expect(changes.map((change: { at: string }) => change.at)).toEqual([NOW.toISOString(), LATER.toISOString()]);
    });

    it("a move into dollars waits for a dollar expense that is still being recorded", async () => {
      const { started, ivan, petr } = await desk({ RUB: "1000", USD: "100" });
      const id = await record(started, ivan, expense({ amountMinor: 1_000 }));
      await slowDown(started, "INSERT", "NEW.comment = 'slow'");
      const spend = postJson(started, "/api/operations", expense({ currency: "USD", amountMinor: 10_000, comment: "slow" }), petr);
      await untilSlowedDown(started);
      // All the dollars are being spent; moving this expense into dollars must see that.
      const move = edit(started, ivan, id, expenseEdit({ currency: "USD", amountMinor: 10_000 }));

      const [spent, moved] = await Promise.all([spend, move]);

      expect([spent.status, moved.status]).toEqual([201, 422]);
      expect((await balances(started, ivan))[1]).toEqual({ currency: "USD", amountMinor: 0 });
    });

    it("a deletion that is still being written holds back an expense that would spend what it takes away", async () => {
      const { started, ivan, petr } = await desk();
      const funds = await record(started, ivan, income({ amountMinor: 50_000 }));
      await slowDown(started, "UPDATE", "NEW.deleted_at IS NOT NULL");
      const deletion = remove(started, ivan, funds);
      await untilSlowedDown(started);
      const spend = postJson(started, "/api/operations", expense({ amountMinor: 50_000 }), petr);

      const [deleted, spent] = await Promise.all([deletion, spend]);

      expect([deleted.status, spent.status]).toEqual([200, 422]);
      expect((await balances(started, ivan))[0]).toEqual({ currency: "RUB", amountMinor: 0 });
    });

    it("a correction that is still being written holds back an expense that would spend what it takes", async () => {
      const { started, ivan, petr } = await desk({ RUB: "1000" });
      const id = await record(started, ivan, expense({ amountMinor: 10_000 }));
      await slowDown(started, "UPDATE", "NEW.revision = 1");
      const raise = edit(started, ivan, id, expenseEdit({ amountMinor: 80_000 }));
      await untilSlowedDown(started);
      const spend = postJson(started, "/api/operations", expense({ amountMinor: 50_000 }), petr);

      const [raised, spent] = await Promise.all([raise, spend]);

      expect([raised.status, spent.status]).toEqual([200, 422]);
      expect((await balances(started, ivan))[0]).toEqual({ currency: "RUB", amountMinor: 20_000 });
    });
  });

  describe("what the database refuses to whoever writes to it, the application or not", () => {
    /** The six fields of an operation that the history keeps, as the database sees them. */
    const SNAPSHOT_SQL = `jsonb_build_object('amountMinor', amount_minor, 'currency', currency, 'category', category,
      'recipient', recipient, 'clientCode', client_code, 'comment', comment)`;

    it("does not count a change recorded in a temporary table that stands in for the history", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income({ amountMinor: 50_000 }));

      await expect(
        started.execute(`BEGIN;
          CREATE TEMP TABLE operation_changes (operation_id uuid, revision int);
          INSERT INTO operation_changes VALUES ('${id}', 1);
          UPDATE operations SET amount_minor = 12345, revision = 1 WHERE id = '${id}';
          COMMIT;`),
      ).rejects.toThrow(/no line in its history/);
      const kept = await started.query<{ amount_minor: string }>("SELECT amount_minor FROM operations WHERE id = $1", [id]);
      expect(kept).toEqual([{ amount_minor: "50000" }]);
    });

    it("does not count a line of history that rests on a temporary table standing in for the operations", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income());

      await expect(
        started.execute(`BEGIN;
          CREATE TEMP TABLE operations (id uuid, revision int);
          INSERT INTO operations VALUES ('${id}', 5);
          INSERT INTO public.operation_changes (operation_id, revision, action, changed_at, changed_by, state_before)
            SELECT '${id}', 1, 'delete', now(), id, '{}' FROM public.users WHERE login = 'ivan';
          COMMIT;`),
      ).rejects.toThrow(/never reached/);
    });

    it("refuses a line of history that does not say what the operation was before", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income({ amountMinor: 50_000 }));

      await expect(
        started.execute(`BEGIN;
          UPDATE operations SET amount_minor = 99999, comment = 'tampered', revision = revision + 1 WHERE id = '${id}';
          INSERT INTO operation_changes (operation_id, revision, action, changed_at, changed_by, reason, state_before)
            SELECT '${id}', 1, 'edit', now(), (SELECT id FROM users WHERE login = 'petr'), 'cleanup', '{}'::jsonb;
          COMMIT;`),
      ).rejects.toThrow(/does not describe/);
    });

    it("refuses a deletion written down as an edit, and an edit written down as a deletion", async () => {
      const { started, ivan } = await desk();
      const deleted = await record(started, ivan, income());
      const edited = await record(started, ivan, income({ clientCode: "K18" }));

      await expect(
        started.execute(`BEGIN;
          INSERT INTO operation_changes (operation_id, revision, action, changed_at, changed_by, state_before)
            SELECT id, 1, 'edit', now(), author_id, ${SNAPSHOT_SQL} FROM operations WHERE id = '${deleted}';
          UPDATE operations SET deleted_at = now(), deleted_by = author_id, revision = 1 WHERE id = '${deleted}';
          COMMIT;`),
      ).rejects.toThrow(/does not describe/);
      await expect(
        started.execute(`BEGIN;
          INSERT INTO operation_changes (operation_id, revision, action, changed_at, changed_by, state_before)
            SELECT id, 1, 'delete', now(), author_id, ${SNAPSHOT_SQL} FROM operations WHERE id = '${edited}';
          UPDATE operations SET amount_minor = 1, revision = 1 WHERE id = '${edited}';
          COMMIT;`),
      ).rejects.toThrow(/does not describe/);
    });

    it("insists that the line of a deletion names the person and the time of the deletion", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income());
      const deletion = (changedAt: string, changedBy: string) => `BEGIN;
        INSERT INTO operation_changes (operation_id, revision, action, changed_at, changed_by, state_before)
          SELECT id, 1, 'delete', ${changedAt}, ${changedBy}, ${SNAPSHOT_SQL} FROM operations WHERE id = '${id}';
        UPDATE operations SET deleted_at = now(), deleted_by = author_id, revision = 1 WHERE id = '${id}';
        COMMIT;`;

      await expect(started.execute(deletion("now()", "(SELECT id FROM users WHERE login = 'petr')"))).rejects.toThrow(
        /does not describe/,
      );
      await expect(started.execute(deletion("now() - interval '1 minute'", "author_id"))).rejects.toThrow(
        /does not describe/,
      );
      await started.execute(deletion("now()", "author_id"));

      const [row] = await started.query<{ revision: number; deleted: boolean }>(
        "SELECT revision, deleted_at IS NOT NULL AS deleted FROM operations WHERE id = $1",
        [id],
      );
      expect(row).toEqual({ revision: 1, deleted: true });
    });

    it("accepts a line of history that does say what the operation was before, in either order", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income({ amountMinor: 50_000 }));

      await started.execute(`BEGIN;
        UPDATE operations SET amount_minor = 60000, revision = 1 WHERE id = '${id}';
        INSERT INTO operation_changes (operation_id, revision, action, changed_at, changed_by, state_before)
          VALUES ('${id}', 1, 'edit', now(), (SELECT author_id FROM operations WHERE id = '${id}'),
            '{"amountMinor": 50000, "currency": "RUB", "category": null, "recipient": null, "clientCode": "K17", "comment": null}');
        COMMIT;`);

      const [row] = await started.query<{ amount_minor: string; revision: number }>(
        "SELECT amount_minor, revision FROM operations WHERE id = $1",
        [id],
      );
      expect(row).toEqual({ amount_minor: "60000", revision: 1 });
    });

    it("refuses an operation that is inserted already corrected or already deleted", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income());

      await expect(
        started.execute(
          `INSERT INTO operations (id, kind, amount_minor, currency, client_code, client_code_key, author_id, created_at, revision)
           SELECT gen_random_uuid(), 'income', 1, 'RUB', 'K', 'k', author_id, now(), 3 FROM operations WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/starts at revision 0/);
      await expect(
        started.execute(
          `INSERT INTO operations (id, kind, amount_minor, currency, client_code, client_code_key, author_id, created_at, deleted_at, deleted_by)
           SELECT gen_random_uuid(), 'income', 1, 'RUB', 'K', 'k', author_id, now(), now(), author_id FROM operations WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/starts at revision 0/);
    });

    it("never lets the identity of an operation, or who deleted it, change", async () => {
      const { started, ivan } = await desk({ RUB: "1000" });
      const incomeId = await record(started, ivan, income());
      const expenseId = await record(started, ivan, expense());
      await remove(started, ivan, incomeId);

      await expect(started.execute("UPDATE operations SET id = gen_random_uuid() WHERE id = $1", [expenseId])).rejects.toThrow(
        /never change/,
      );
      await expect(
        started.execute(
          "UPDATE operations SET kind = 'income', category = NULL, client_code = 'K', client_code_key = 'k', revision = revision + 1 WHERE id = $1",
          [expenseId],
        ),
      ).rejects.toThrow(/never change/);
      await expect(
        started.execute("UPDATE operations SET deleted_by = (SELECT id FROM users WHERE login = 'petr') WHERE id = $1", [incomeId]),
      ).rejects.toThrow(/final/);
    });

    it("does not take an update that says nothing new for a change", async () => {
      const { started, ivan } = await desk();
      const id = await record(started, ivan, income({ amountMinor: 50_000 }));

      await started.execute("UPDATE operations SET amount_minor = amount_minor WHERE id = $1", [id]);

      const [row] = await started.query<{ revision: number }>("SELECT revision FROM operations WHERE id = $1", [id]);
      expect(row!.revision).toBe(0);
    });
  });
});
