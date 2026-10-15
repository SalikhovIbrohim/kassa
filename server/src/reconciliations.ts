import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { getBalances, type Balance, type Queryable } from "./balances.js";
import { inTransaction, lockBalances } from "./ledger.js";
import { CURRENCIES, type Currency } from "./money.js";
import type { Outbox } from "./outbox.js";
import { defaultKassa, KASSA_CURRENCIES, kassaProperty, mayUseKassa, type Kassa } from "./kassa.js";
import { UUID } from "./schemas.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
/** The largest cash count accepted, in minor units: far above any real cash desk, far below what a number holds exactly. */
const MAX_COUNTED_MINOR = 1_000_000_000_000_000;

export type ReconciliationsOptions = {
  pool: pg.Pool;
  now: () => Date;
  /** The Telegram group, told in its main topic what is left after each count. */
  outbox?: Outbox;
};

type Person = { login: string; displayName: string };

/** A count of the cash as it is read: who made it, when, and per currency what the book said, what was counted, the difference. */
export type ReconciliationReport = {
  id: string;
  /** The cash desk that was counted. */
  kassa: Kassa;
  madeAt: string;
  madeBy: Person;
  currencies: Array<{
    currency: Currency;
    /** What the book said at that moment. */
    calculatedMinor: number;
    /** What was counted in the cash desk. */
    actualMinor: number;
    /** Counted minus book: a shortage is negative, a surplus positive. */
    differenceMinor: number;
  }>;
  /**
   * The part of the rubles counted that lay on the cards: the rubles are one, cash and cards together, so `actualMinor`
   * of the rubles includes it; it is kept only to say how the rubles left are split. Null for the counts of before.
   */
  cardMinor: number | null;
};

type ReportRow = { id: string; kassa: Kassa; made_at: Date; login: string; display_name: string; card_minor: string | null };

/** Reads the reconciliations that `where` picks (newest first), with their figures. */
async function readReports(db: Queryable, where: string, params: unknown[], limit: number): Promise<ReconciliationReport[]> {
  const found = await db.query<ReportRow>(
    `SELECT r.id, r.kassa, r.made_at, u.login, u.display_name, r.card_minor
       FROM reconciliations r JOIN users u ON u.id = r.made_by
       ${where} ORDER BY r.made_at DESC, r.id DESC LIMIT ${limit}`,
    params,
  );
  if (found.rows.length === 0) return [];
  const figures = await db.query<{
    reconciliation_id: string;
    currency: Currency;
    calculated_minor: string;
    actual_minor: string;
    difference_minor: string;
  }>("SELECT * FROM reconciliation_balances WHERE reconciliation_id = ANY($1::uuid[])", [found.rows.map((row) => row.id)]);
  return found.rows.map((row) => ({
    id: row.id,
    kassa: row.kassa,
    madeAt: row.made_at.toISOString(),
    madeBy: { login: row.login, displayName: row.display_name },
    currencies: KASSA_CURRENCIES[row.kassa].map((currency) => {
      const figure = figures.rows.find((item) => item.reconciliation_id === row.id && item.currency === currency);
      return {
        currency,
        calculatedMinor: Number(figure?.calculated_minor ?? 0),
        actualMinor: Number(figure?.actual_minor ?? 0),
        differenceMinor: Number(figure?.difference_minor ?? 0),
      };
    }),
    cardMinor: row.card_minor === null ? null : Number(row.card_minor),
  }));
}

export type ReconcileResult =
  | { status: "made" | "replayed"; reconciliation: ReconciliationReport; balances: Balance[] }
  /** The id belongs to another count, or to one somebody else made. */
  | { status: "id_conflict" };

/**
 * Counts the cash against the book. For each currency the book says what the cash desk should hold (everything entered,
 * plus what earlier counts found), the person says what is really there, and the difference is kept, in their name. From
 * then on the book says what was counted. The balances are held still meanwhile, so that no entry slips in between the two
 * figures. Sending the same count again (same id) answers as before: a lost answer does not count the cash twice.
 */
export async function reconcile(
  pool: pg.Pool,
  request: { id: string; kassa: Kassa; madeBy: string; counted: Balance[]; cardMinor?: number; now: Date },
  outbox?: Outbox,
): Promise<ReconcileResult> {
  // The rubles are counted as one: what is in the box and what is on the cards.
  const counted = request.counted.map((item) =>
    item.currency === "RUB" ? { ...item, amountMinor: item.amountMinor + (request.cardMinor ?? 0) } : item,
  );
  return inTransaction(pool, async (client): Promise<ReconcileResult> => {
    await lockBalances(client, CURRENCIES);
    const [stored] = await readReports(client, "WHERE r.id = $1", [request.id], 1);
    if (stored) {
      const who = await client.query<{ made_by: string }>("SELECT made_by FROM reconciliations WHERE id = $1", [request.id]);
      const same =
        who.rows[0]?.made_by === request.madeBy &&
        stored.kassa === request.kassa &&
        counted.every((item) => stored.currencies.find((figure) => figure.currency === item.currency)?.actualMinor === item.amountMinor) &&
        stored.cardMinor === (request.cardMinor ?? null);
      return same ? { status: "replayed", reconciliation: stored, balances: await getBalances(client, request.kassa) } : { status: "id_conflict" };
    }

    const books = await getBalances(client, request.kassa);
    await client.query("INSERT INTO reconciliations (id, kassa, made_by, made_at, card_minor) VALUES ($1, $2, $3, $4, $5)", [
      request.id,
      request.kassa,
      request.madeBy,
      request.now,
      request.cardMinor ?? null,
    ]);
    for (const { currency, amountMinor: actual } of counted) {
      const calculated = books.find((item) => item.currency === currency)?.amountMinor ?? 0;
      await client.query(
        `INSERT INTO reconciliation_balances (reconciliation_id, currency, calculated_minor, actual_minor, difference_minor)
         VALUES ($1, $2, $3::bigint, $4::bigint, $4::bigint - $3::bigint)`,
        [request.id, currency, calculated, actual],
      );
    }
    const [reconciliation] = await readReports(client, "WHERE r.id = $1", [request.id], 1);
    if (!reconciliation) throw new Error(`Reconciliation ${request.id} was made and is not there`);
    if (outbox?.enabled) await outbox.queue(client, leftText(reconciliation), null, request.kassa === "andijan" ? "andijan" : "general");
    return { status: "made", reconciliation, balances: await getBalances(client, request.kassa) };
  });
}

/** "208000" rubles -> "208.000", "5300,50" -> "5.300,50": the way the cashiers write sums in the group. */
function groupAmount(minor: number): string {
  const whole = String(Math.floor(minor / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const cents = minor % 100;
  return cents === 0 ? whole : `${whole},${String(cents).padStart(2, "0")}`;
}

/** What the group reads after a count, as the cashiers used to write it by hand: cash, cards, dollars. */
export function leftText(report: ReconciliationReport): string {
  const counted = (currency: Currency) => report.currencies.find((item) => item.currency === currency)?.actualMinor ?? 0;
  const rubles = report.currencies.some((item) => item.currency === "RUB");
  return [
    "Кассада колган пул",
    ...(rubles ? [`${groupAmount(counted("RUB") - (report.cardMinor ?? 0))}₽. Наличка`] : []),
    ...(report.cardMinor === null ? [] : [`${groupAmount(report.cardMinor)}₽. Карталарда`]),
    `${groupAmount(counted("USD"))}$. Доллар`,
  ].join("\n");
}

export async function registerReconciliations(app: FastifyInstance, options: ReconciliationsOptions) {
  const { pool, now, outbox } = options;

  // The owner reads the counts of the cash, and so does the cashier who makes them: who counted, when, and how it came
  // out. Newest first.
  app.get<{ Querystring: { limit?: string; before?: string; kassa?: Kassa } }>(
    "/api/reconciliations",
    {
      onRequest: [app.authenticate, app.requireRole("viewer", "admin")],
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "string", pattern: "^[0-9]{1,3}$" },
            // Where the previous page ended: the time the last reconciliation of it was made.
            before: { type: "string", format: "date-time", maxLength: 40 },
            // One cash desk; without it, both.
            kassa: kassaProperty,
          },
        },
      },
    },
    async (request, reply) => {
      const limit = request.query.limit === undefined ? DEFAULT_PAGE_SIZE : Number(request.query.limit);
      if (limit < 1 || limit > MAX_PAGE_SIZE) {
        return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: `querystring/limit must be from 1 to ${MAX_PAGE_SIZE}` });
      }
      const before = request.query.before === undefined ? null : new Date(request.query.before);
      const kassa = request.query.kassa ?? null;
      const rows = await readReports(pool, "WHERE ($1::timestamptz IS NULL OR r.made_at < $1) AND ($2::text IS NULL OR r.kassa = $2)", [before, kassa], limit + 1);
      const reconciliations = rows.slice(0, limit);
      const last = reconciliations.at(-1);
      return { reconciliations, nextBefore: rows.length > limit && last ? last.madeAt : null };
    },
  );

  // The admin counts the cash, one amount per currency. The id is made by the client, like that of an entry.
  app.post<{ Body: { id: string; counted: Balance[]; cardMinor?: number; kassa?: Kassa } }>(
    "/api/reconciliations",
    {
      onRequest: [app.authenticate, app.requireRole("head_cashier")],
      schema: {
        body: {
          type: "object",
          required: ["id", "counted"],
          additionalProperties: false,
          properties: {
            id: UUID,
            counted: {
              type: "array",
              minItems: 1,
              maxItems: CURRENCIES.length,
              items: {
                type: "object",
                required: ["currency", "amountMinor"],
                additionalProperties: false,
                properties: {
                  currency: { type: "string", enum: [...CURRENCIES] },
                  amountMinor: { type: "integer", minimum: 0, maximum: MAX_COUNTED_MINOR },
                },
              },
            },
            // What lies on the cards, in rubles. Optional: a page of before does not send it.
            cardMinor: { type: "integer", minimum: 0, maximum: MAX_COUNTED_MINOR },
            // The cash desk counted; without it, the person's own.
            kassa: kassaProperty,
          },
        },
      },
    },
    async (request, reply) => {
      const { id, counted, cardMinor } = request.body;
      const kassa = request.body.kassa ?? defaultKassa(request.user!.city);
      if (!mayUseKassa(request.user!.city, kassa)) return reply.code(403).send({ error: "kassa_forbidden" });
      const kept = KASSA_CURRENCIES[kassa];
      const named = new Set(counted.map((item) => item.currency));
      if (named.size !== counted.length || named.size !== kept.length || !kept.every((currency) => named.has(currency))) {
        return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "body/counted must name each currency of the cash desk once" });
      }
      if (cardMinor !== undefined && !kept.includes("RUB")) {
        return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "body/cardMinor is for a cash desk of rubles" });
      }
      const result = await reconcile(pool, { id, kassa, madeBy: request.user!.id, counted, cardMinor, now: now() }, outbox);
      if (result.status === "id_conflict") return reply.code(409).send({ error: "reconciliation_id_conflict" });
      // The message was written with the count; now that it is committed, the worker is asked to send it.
      if (result.status === "made") outbox?.nudge();
      return reply.code(result.status === "made" ? 201 : 200).send({ reconciliation: result.reconciliation, balances: result.balances });
    },
  );
}
