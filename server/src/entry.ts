import { EXPENSE_CATEGORY_CODES, REFUND_CATEGORY, type ExpenseCategory } from "./categories.js";
import type { Snapshot } from "./ledger.js";
import { CURRENCIES, MAX_AMOUNT_MINOR } from "./money.js";
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
  clientCode: string;
  comment?: string;
};

export type ExpenseEntry = {
  type: "expense";
  amountMinor: number;
  currency: "RUB" | "USD";
  category: ExpenseCategory;
  recipient?: string;
  clientCode?: string;
  comment?: string;
};

export type Entry = IncomeEntry | ExpenseEntry;

const clientCodeProperty = { type: "string", minLength: 1, maxLength: 64, pattern: NO_NUL } as const;

const commonProperties = {
  amountMinor: { type: "integer", minimum: 1, maximum: MAX_AMOUNT_MINOR },
  currency: { type: "string", enum: [...CURRENCIES] },
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
        required: [...extra.required, "type", "amountMinor", "currency", "clientCode"],
        additionalProperties: false,
        properties: {
          ...commonProperties,
          ...extra.properties,
          type: { type: "string", const: "income" },
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
          category: { type: "string", enum: EXPENSE_CATEGORY_CODES },
          recipient: { type: "string", maxLength: 100, pattern: NO_NUL },
          clientCode: clientCodeProperty,
        },
      },
    ],
  };
}

export type NormalizedEntry = { kind: "income" | "expense"; fields: Snapshot } | { error: string };

/**
 * Cleans the text (see `cleanText`), turns blanks into "nothing", and applies the rules the
 * schema cannot: an income and a client refund name a client, no other expense does.
 */
export function normalizeEntry(body: Entry): NormalizedEntry {
  const comment = cleanText(body.comment ?? "") || null;
  let category: ExpenseCategory | null = null;
  let recipient: string | null = null;
  let clientCode: string | null = null;

  if (body.type === "income") {
    clientCode = cleanText(body.clientCode);
    if (clientCode === "") return { error: "body/clientCode must not be blank" };
  } else {
    category = body.category;
    recipient = cleanText(body.recipient ?? "") || null;
    if (category === REFUND_CATEGORY) {
      clientCode = cleanText(body.clientCode ?? "");
      if (clientCode === "") return { error: "body/clientCode is required for a client refund" };
    } else if (body.clientCode !== undefined) {
      return { error: "body/clientCode is only allowed for a client refund" };
    }
  }

  return {
    kind: body.type,
    fields: {
      amountMinor: body.amountMinor,
      currency: body.currency,
      category,
      recipient,
      clientCode,
      comment,
    },
  };
}
