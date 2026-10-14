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
  /** An entry of it must say the number of the trip, the counterparty, the employee. */
  requiresTrip: boolean;
  requiresCounterparty: boolean;
  /** An entry of it must name the employee. */
  requiresEmployee: boolean;
  /** The city it belongs to, for the reports and 1C; null is everywhere. */
  city: "andijan" | "moscow" | null;
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
  requires_trip: boolean;
  requires_counterparty: boolean;
  requires_employee: boolean;
  city: "andijan" | "moscow" | null;
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
    requiresTrip: row.requires_trip,
    requiresCounterparty: row.requires_counterparty,
    requiresEmployee: row.requires_employee,
    city: row.city,
    countsAsCost: row.counts_as_cost,
    notifyGroup: row.notify_group,
  };
}

/** Every category, archived ones too, incomes first, each kind in its order. */
export async function readCategories(db: Queryable): Promise<Category[]> {
  const found = await db.query<CategoryRow>(
    `SELECT code, kind, label, sort_order, archived, requires_client, requires_trip, requires_counterparty, requires_employee, city, counts_as_cost, notify_group
       FROM categories ORDER BY kind DESC, sort_order, code`,
  );
  return found.rows.map(toCategory);
}

/**
 * Whether the entry forms of a person of `city` offer the category: a category of everywhere is offered to all, a
 * category of a city only to the people of that city and to those of everywhere. It only hides: an entry of a category
 * of another city is not turned away (an entry waiting on a phone must not fail because a city was changed meanwhile).
 */
export function isForCity(category: Pick<Category, "city">, city: Category["city"]): boolean {
  return category.city === null || city === null || category.city === city;
}

/** What an income that names no category is: the entries of phones that were made before there were categories of income. */
export const DEFAULT_INCOME_CATEGORY = "client_payment";

/** An income of a client: the category of payments of clients, and the incomes of before there were categories of income (those are payments too). */
export function isClientPayment(kind: "income" | "expense", category: string | null): boolean {
  return kind === "income" && (category === null || category === DEFAULT_INCOME_CATEGORY);
}
