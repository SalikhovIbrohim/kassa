import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { cashDayEnd, cashDayOf, cashDayStart } from "./cash-day.js";
import { EXPENSE_CATEGORIES, HANDOVER_CATEGORY } from "./categories.js";
import { CURRENCIES, type Currency } from "./money.js";

export type SummaryOptions = {
  pool: pg.Pool;
  now: () => Date;
};

export type CurrencySummary = {
  currency: Currency;
  /** The balance when the first day of the period begins. */
  openingMinor: number;
  incomeMinor: number;
  /** Everything paid out except the money handed to the owner (that is not a cost of the business). */
  expenseMinor: number;
  handoverMinor: number;
  /** What counting the cash found at the end of the shifts closed in the period: a shortage is negative, a surplus positive. */
  differenceMinor: number;
  /** The balance when the last day of the period ends. */
  closingMinor: number;
  /** Where the expense went, every category, in the order of the list, zeros included. */
  expenseByCategory: Array<{ category: string; amountMinor: number }>;
};

/** The categories that are costs: all but the handover to the owner. */
const COST_CATEGORIES = EXPENSE_CATEGORIES.filter((category) => category.code !== HANDOVER_CATEGORY);

type SummaryQuery = { from?: string; to?: string };

/**
 * The totals of a period for the viewer, each currency on its own: the balance at the start, income, expense by
 * category, handover to the owner, what counting the cash found, the balance at the end. Whatever the period,
 * opening + income - expense - handover + difference = closing. A deleted operation counts for nothing; a
 * corrected one counts as it says now.
 */
export async function registerSummary(app: FastifyInstance, options: SummaryOptions) {
  const { pool, now } = options;

  app.get<{ Querystring: SummaryQuery }>(
    "/api/summary",
    {
      onRequest: [app.authenticate, app.requireRole("viewer")],
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            from: { type: "string", format: "date" },
            to: { type: "string", format: "date" },
          },
        },
      },
    },
    async (request, reply) => {
      const query = request.query;
      // One bound on its own means that single day; neither means today (as in the journal).
      const from = query.from ?? query.to ?? cashDayOf(now());
      const to = query.to ?? query.from ?? from;
      if (from > to) {
        return reply
          .code(400)
          .send({ statusCode: 400, error: "Bad Request", message: "querystring/from must not be after querystring/to" });
      }

      // One statement, so one snapshot of the database: the balances and the sums cannot come from two moments.
      const start = cashDayStart(from);
      const end = cashDayEnd(to);
      const values: unknown[] = [start, end, [...CURRENCIES]];
      const inPeriod = "op.created_at >= $1 AND op.created_at < $2";
      const categoryColumns = COST_CATEGORIES.map((category, index) => {
        values.push(category.code);
        return `COALESCE(SUM(op.amount_minor) FILTER (WHERE op.kind = 'expense' AND op.category = $${values.length} AND ${inPeriod}), 0) AS category_${index}`;
      });
      values.push(HANDOVER_CATEGORY);
      const handover = `$${values.length}`;

      const result = await pool.query(
        `SELECT c.currency,
                COALESCE(ob.amount_minor, 0) AS opening_balance,
                COALESCE(SUM(CASE op.kind WHEN 'income' THEN op.amount_minor ELSE -op.amount_minor END), 0) AS until_end,
                COALESCE(SUM(CASE op.kind WHEN 'income' THEN op.amount_minor ELSE -op.amount_minor END)
                         FILTER (WHERE op.created_at < $1), 0) AS until_start,
                COALESCE(SUM(op.amount_minor) FILTER (WHERE op.kind = 'income' AND ${inPeriod}), 0) AS income,
                COALESCE(SUM(op.amount_minor) FILTER (WHERE op.kind = 'expense' AND op.category = ${handover} AND ${inPeriod}), 0) AS handover,
                COALESCE((SELECT SUM(sb.difference_minor) FROM shift_balances sb JOIN shifts s ON s.id = sb.shift_id
                           WHERE sb.currency = c.currency AND s.closed_at < $2), 0) AS difference_until_end,
                COALESCE((SELECT SUM(sb.difference_minor) FROM shift_balances sb JOIN shifts s ON s.id = sb.shift_id
                           WHERE sb.currency = c.currency AND s.closed_at < $1), 0) AS difference_until_start,
                ${categoryColumns.join(",\n                ")}
           FROM unnest($3::text[]) AS c(currency)
           LEFT JOIN opening_balances ob ON ob.currency = c.currency
           LEFT JOIN operations op ON op.currency = c.currency AND op.deleted_at IS NULL AND op.created_at < $2
          GROUP BY c.currency, ob.amount_minor
          ORDER BY c.currency`,
        values,
      );

      // bigint comes back as text. Single amounts are capped, so that sums stay exact as numbers (see MAX_AMOUNT_MINOR).
      const currencies: CurrencySummary[] = result.rows.map((row) => {
        const expenseByCategory = COST_CATEGORIES.map((category, index) => ({
          category: category.code,
          amountMinor: Number(row[`category_${index}`]),
        }));
        return {
          currency: row.currency as Currency,
          openingMinor: Number(row.opening_balance) + Number(row.until_start) + Number(row.difference_until_start),
          incomeMinor: Number(row.income),
          expenseMinor: expenseByCategory.reduce((sum, item) => sum + item.amountMinor, 0),
          handoverMinor: Number(row.handover),
          differenceMinor: Number(row.difference_until_end) - Number(row.difference_until_start),
          closingMinor: Number(row.opening_balance) + Number(row.until_end) + Number(row.difference_until_end),
          expenseByCategory,
        };
      });
      return { from, to, currencies };
    },
  );
}
