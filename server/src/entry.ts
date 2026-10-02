import { DEFAULT_INCOME_CATEGORY, type Category } from "./categories.js";
import type { Snapshot } from "./ledger.js";
import { CURRENCIES, MAX_AMOUNT_MINOR, MAX_RATE_E4, MIN_RATE_E4 } from "./money.js";
import { NO_NUL } from "./schemas.js";
import { cleanText } from "./text.js";

/**
 * What a cashier says about an operation, whether writing it for the first time or
 * correcting it: the rules are the same, so they live here once.
 */
export type IncomeEntry = {
  type: "income";
  amountMinor: number;
  currency: "RUB" | "USD";
  /** Rubles for one dollar, times 10 000. Required for rubles, not allowed for dollars. */
  rateE4?: number;
  /** A category of income. Without one it is a payment of a client: the entries of phones from before there were categories. */
  category?: string;
  /** Required when the category names a client, and not allowed otherwise. */
  clientCode?: string;
  comment?: string;
};

export type ExpenseEntry = {
  type: "expense";
  amountMinor: number;
  currency: "RUB" | "USD";
  /** Rubles for one dollar, times 10 000. Optional for rubles (the shift's average is used), not allowed for dollars. */
  rateE4?: number;
  category: string;
  recipient?: string;
  clientCode?: string;
  comment?: string;
};

export type Entry = IncomeEntry | ExpenseEntry;

const clientCodeProperty = { type: "string", minLength: 1, maxLength: 64, pattern: NO_NUL } as const;
/** A code of a category; whether there is such a category is checked against the table (see `normalizeEntry`). */
const categoryProperty = { type: "string", minLength: 1, maxLength: 40, pattern: "^[a-z0-9_]+$" } as const;

const commonProperties = {
  amountMinor: { type: "integer", minimum: 1, maximum: MAX_AMOUNT_MINOR },
  currency: { type: "string", enum: [...CURRENCIES] },
  rateE4: { type: "integer", minimum: MIN_RATE_E4, maximum: MAX_RATE_E4 },
  comment: { type: "string", maxLength: 500, pattern: NO_NUL },
} as const;

/**
 * The JSON schema of an income or an expense. `extra` holds what only some callers take
 * besides the entry itself: the client's id for a new entry, the reason for a correction.
 */
export function entrySchema(extra: { properties: Record<string, unknown>; required: string[] }) {
  return {
    oneOf: [
      {
        type: "object",
        required: [...extra.required, "type", "amountMinor", "currency"],
        additionalProperties: false,
        properties: {
          ...commonProperties,
          ...extra.properties,
          type: { type: "string", const: "income" },
          category: categoryProperty,
          clientCode: clientCodeProperty,
        },
      },
      {
        type: "object",
        required: [...extra.required, "type", "amountMinor", "currency", "category"],
        additionalProperties: false,
        properties: {
          ...commonProperties,
          ...extra.properties,
          type: { type: "string", const: "expense" },
          category: categoryProperty,
          recipient: { type: "string", maxLength: 100, pattern: NO_NUL },
          clientCode: clientCodeProperty,
        },
      },
    ],
  };
}

export type NormalizedEntry = { kind: "income" | "expense"; fields: Snapshot } | { error: string };

/**
 * Cleans the text (see `cleanText`), turns blanks into "nothing", and applies the rules the schema cannot:
 * the category must be one of the table, of the kind of the entry, and not archived (unless the entry has it
 * already: `keep` is the category the operation stored under this id has, so that a retry of an accepted entry
 * and a correction that leaves the category alone are not turned away); a category that names a client needs
 * one, any other does not take one; a rate goes with rubles only, and an income in rubles must have one.
 */
export function normalizeEntry(body: Entry, categories: readonly Category[], keep?: string | null): NormalizedEntry {
  const comment = cleanText(body.comment ?? "") || null;
  const code = body.category ?? (body.type === "income" ? DEFAULT_INCOME_CATEGORY : undefined);
  const category = categories.find((item) => item.code === code && item.kind === body.type);
  if (!category) return { error: `body/category is not a category of ${body.type === "income" ? "incomes" : "expenses"}` };
  if (category.archived && category.code !== keep) return { error: "body/category is not in use any more" };

  const recipient = body.type === "expense" ? cleanText(body.recipient ?? "") || null : null;
  let clientCode: string | null = null;
  if (category.requiresClient) {
    clientCode = cleanText(body.clientCode ?? "");
    if (clientCode === "") return { error: `body/clientCode is required for the category ${category.label}` };
  } else if (body.clientCode !== undefined) {
    return { error: `body/clientCode is not allowed for the category ${category.label}` };
  }

  if (body.currency === "USD" && body.rateE4 !== undefined) {
    return { error: "body/rateE4 is only for rubles" };
  }
  if (body.currency === "RUB" && body.type === "income" && body.rateE4 === undefined) {
    return { error: "body/rateE4 is required for an income in rubles" };
  }

  return {
    kind: body.type,
    fields: {
      amountMinor: body.amountMinor,
      currency: body.currency,
      rateE4: body.rateE4 ?? null,
      category: category.code,
      recipient,
      clientCode,
      comment,
    },
  };
}
