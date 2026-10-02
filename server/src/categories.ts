import type { Queryable } from "./balances.js";

export type CategoryKind = "income" | "expense";

/**
 * A category of incomes or expenses, as the owner keeps them. `code` is what an operation stores and never
 * changes or comes back for another meaning; `label` is what people read and the owner may rewrite.
 */
export type Category = {
  code: string;
  kind: CategoryKind;
  label: string;
  /** Where it stands in the list; the lists are shown in this order. */
  sortOrder: number;
  /** Not offered for new entries any more; the entries that have it keep reading it. */
  archived: boolean;
  /** An entry of this category names a client, and an entry of any other does not. */
  requiresClient: boolean;
  /** The Telegram group is told of the entries of this category (see `groupEvents`). */
  notifyGroup: boolean;
  /** False for the money handed to the owner: it leaves the cash desk but is not a cost of the business. */
  countsAsCost: boolean;
};

type CategoryRow = {
  code: string;
  kind: CategoryKind;
  label: string;
  sort_order: number;
  archived: boolean;
  requires_client: boolean;
  counts_as_cost: boolean;
  notify_group: boolean;
};

export function toCategory(row: CategoryRow): Category {
  return {
    code: row.code,
    kind: row.kind,
    label: row.label,
    sortOrder: row.sort_order,
    archived: row.archived,
    requiresClient: row.requires_client,
    countsAsCost: row.counts_as_cost,
    notifyGroup: row.notify_group,
  };
}

/** Every category, archived ones too, incomes first, each kind in its order. */
export async function readCategories(db: Queryable): Promise<Category[]> {
  const found = await db.query<CategoryRow>(
    `SELECT code, kind, label, sort_order, archived, requires_client, counts_as_cost, notify_group
       FROM categories ORDER BY kind DESC, sort_order, code`,
  );
  return found.rows.map(toCategory);
}

/** What an income that names no category is: the entries of phones that were made before there were categories of income. */
export const DEFAULT_INCOME_CATEGORY = "client_payment";
