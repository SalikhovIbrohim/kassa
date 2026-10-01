import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { getBalances, type Balance, type Queryable } from "./balances.js";
import { inTransaction } from "./ledger.js";
import { CURRENCIES, type Currency } from "./money.js";

export type ShiftsOptions = {
  pool: pg.Pool;
  now: () => Date;
};

export type ShiftView = {
  id: string;
  openedAt: string;
  cashier: { login: string; displayName: string };
  /** What the shift started with, each currency; the cash desk at that moment, or what was counted at the end of the shift before. */
  openingBalances: Balance[];
};

/** The shift that is open now, if any. At most one is: the database sees to it. */
export async function currentShift(db: Queryable): Promise<ShiftView | null> {
  const found = await db.query<{ id: string; opened_at: Date; login: string; display_name: string }>(
    `SELECT s.id, s.opened_at, u.login, u.display_name
       FROM shifts s JOIN users u ON u.id = s.cashier_id
      WHERE s.closed_at IS NULL`,
  );
  const row = found.rows[0];
  if (!row) return null;
  const balances = await db.query<{ currency: Currency; opening_minor: string }>(
    "SELECT currency, opening_minor FROM shift_balances WHERE shift_id = $1",
    [row.id],
  );
  const opening = new Map(balances.rows.map((item) => [item.currency, Number(item.opening_minor)]));
  return {
    id: row.id,
    openedAt: row.opened_at.toISOString(),
    cashier: { login: row.login, displayName: row.display_name },
    openingBalances: CURRENCIES.map((currency) => ({ currency, amountMinor: opening.get(currency) ?? 0 })),
  };
}

/**
 * What a shift that opens now starts with: what was counted at the end of the shift that closed last, and
 * for a currency with no such count (the first shift ever) what the books say at this moment.
 */
async function openingBalancesNow(db: Queryable): Promise<Balance[]> {
  const books = await getBalances(db);
  const counted = await db.query<{ currency: Currency; actual_minor: string }>(
    `SELECT currency, actual_minor
       FROM shift_balances
      WHERE actual_minor IS NOT NULL
        AND shift_id = (SELECT id FROM shifts WHERE closed_at IS NOT NULL ORDER BY closed_at DESC, opened_at DESC LIMIT 1)`,
  );
  const actual = new Map(counted.rows.map((item) => [item.currency, Number(item.actual_minor)]));
  return books.map((balance) => ({ currency: balance.currency, amountMinor: actual.get(balance.currency) ?? balance.amountMinor }));
}

export async function registerShifts(app: FastifyInstance, options: ShiftsOptions) {
  const { pool, now } = options;

  // Anyone signed in may look: the cashier to see whether to open one, the owner to see who is working.
  app.get("/api/shifts/current", { onRequest: app.authenticate }, async () => ({ shift: await currentShift(pool) }));

  // A cashier opens a shift. Only one is open at a time in the whole cash desk.
  app.post("/api/shifts", { onRequest: [app.authenticate, app.requireRole("cashier")] }, async (request, reply) => {
    const opened = await inTransaction(pool, async (client): Promise<{ shift: ShiftView } | { already: ShiftView | null }> => {
      const existing = await currentShift(client);
      if (existing) return { already: existing };

      const opening = await openingBalancesNow(client);
      // Two cashiers can get here together: the unique index lets one of them in, and the other
      // inserts nothing (its transaction waited for the first to finish).
      const inserted = await client.query<{ id: string }>(
        "INSERT INTO shifts (cashier_id, opened_at) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id",
        [request.user!.id, now()],
      );
      const id = inserted.rows[0]?.id;
      if (!id) return { already: await currentShift(client) };

      for (const balance of opening) {
        await client.query("INSERT INTO shift_balances (shift_id, currency, opening_minor) VALUES ($1, $2, $3)", [
          id,
          balance.currency,
          balance.amountMinor,
        ]);
      }
      const shift = await currentShift(client);
      if (!shift) throw new Error(`Shift ${id} was opened and is not there`);
      return { shift };
    });

    if ("shift" in opened) return reply.code(201).send({ shift: opened.shift });
    return reply.code(409).send({
      error: "shift_already_open",
      message: "A shift is open already: only one shift can be open at a time.",
      shift: opened.already,
    });
  });
}
