import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";
import { readCategories, type Category, type CategoryKind } from "../categories.js";
import type { Kassas } from "../kassa.js";
import { inTransaction } from "../ledger.js";
import { cleanText } from "../text.js";
import { AdminError } from "./users.js";

/** A category as a file of categories says it. */
type Wanted = {
  kind: CategoryKind;
  label: string;
  /** The code of a category that is there already and becomes this one (`client_payment` is the payment of a client). */
  code: string | undefined;
  city: string | null;
  requiresClient: boolean;
  requiresTrip: boolean;
  requiresCounterparty: boolean;
  requiresEmployee: boolean;
};

const FLAGS = ["requiresClient", "requiresTrip", "requiresCounterparty", "requiresEmployee"] as const;
const KNOWN = new Set<string>(["label", "code", "city", ...FLAGS]);
const KINDS = ["income", "expense"] as const;

/**
 * The lists of a file of categories: `{ "income": [...], "expense": [...] }`, each category `{ "label": "Обед" }` with,
 * when it has them, `"city"` (the id of a cash desk; none is everywhere), `"requiresClient"`, `"requiresTrip"`,
 * `"requiresCounterparty"`, `"requiresEmployee"` and `"code"`. A slip in the file is said, and nothing is changed.
 */
export function readCategoryFile(path: string, kassas: Kassas): Wanted[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  } catch (error) {
    throw new AdminError(`${path} could not be read as JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new AdminError(`${path} must be { "income": [...], "expense": [...] }`);
  const wanted: Wanted[] = [];
  for (const kind of KINDS) {
    const list = (parsed as Record<string, unknown>)[kind];
    if (!Array.isArray(list) || list.length === 0) throw new AdminError(`${path}: "${kind}" must be a list with at least one category (a form with an empty list cannot be filled in)`);
    const labels = new Set<string>();
    for (const [index, item] of list.entries()) {
      const where = `${path}: ${kind} ${index + 1}`;
      if (typeof item !== "object" || item === null || Array.isArray(item)) throw new AdminError(`${where} must be { "label": ... }`);
      const fields = item as Record<string, unknown>;
      const stranger = Object.keys(fields).find((name) => !KNOWN.has(name));
      if (stranger) throw new AdminError(`${where}: "${stranger}" is not known (label, city, code, ${FLAGS.join(", ")})`);
      const label = typeof fields.label === "string" ? cleanText(fields.label) : "";
      if (label === "" || label.length > 60) throw new AdminError(`${where}: "label" must be a name of 1 to 60 signs`);
      if (labels.has(label.toLowerCase())) throw new AdminError(`${where}: «${label}» is in the list twice`);
      labels.add(label.toLowerCase());
      const city = fields.city ?? null;
      if (city !== null && (typeof city !== "string" || !kassas.has(city))) throw new AdminError(`${where}: "city" must be ${kassas.ids.join(" or ")} (KASSAS), or left out for everywhere`);
      if (fields.code !== undefined && typeof fields.code !== "string") throw new AdminError(`${where}: "code" must be the code of a category that is there`);
      for (const flag of FLAGS) if (fields[flag] !== undefined && typeof fields[flag] !== "boolean") throw new AdminError(`${where}: "${flag}" must be true or false`);
      wanted.push({
        kind,
        label,
        code: fields.code as string | undefined,
        city: city as string | null,
        requiresClient: fields.requiresClient === true,
        requiresTrip: fields.requiresTrip === true,
        requiresCounterparty: fields.requiresCounterparty === true,
        requiresEmployee: fields.requiresEmployee === true,
      });
    }
  }
  return wanted;
}

/**
 * Makes the lists of categories those of a file, in its order: a category that is there under the same name (or under
 * the code the file says) is kept and set as the file says, a new one is added, and every other one goes to the
 * archive (never deleted: old entries keep reading it). Whether the Telegram group is told of a category is left as
 * it is; a new expense is told of and a new income is not, as the first lists were. All of it or nothing.
 */
export async function setCategories(pool: pg.Pool, wanted: readonly Wanted[]): Promise<string[]> {
  const lines: string[] = [];
  try {
    await inTransaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('kassa.categories'))");
      const all = await readCategories(client);
      const taken = new Set<string>();
      const plan: Array<{ item: Wanted; found: Category | undefined }> = [];
      // The categories the file names by code first: a name must not take the row that a code asks for.
      for (const item of wanted) {
        if (item.code === undefined) continue;
        const found = all.find((category) => category.code === item.code);
        if (!found) throw new AdminError(`«${item.label}»: there is no category with the code ${item.code}`);
        if (found.kind !== item.kind) throw new AdminError(`«${item.label}»: the category ${item.code} is an ${found.kind}, not an ${item.kind}`);
        if (taken.has(found.code)) throw new AdminError(`the code ${item.code} is in the file twice`);
        taken.add(found.code);
      }
      for (const item of wanted) {
        const found =
          item.code !== undefined
            ? all.find((category) => category.code === item.code)
            : all.find((category) => category.kind === item.kind && !taken.has(category.code) && category.label.trim().toLowerCase() === item.label.toLowerCase());
        if (found) taken.add(found.code);
        plan.push({ item, found });
      }

      // The ones that go first, out of the way of the names and of the order of the ones that stay.
      const leaving = all.filter((category) => !taken.has(category.code));
      for (const category of leaving) {
        await client.query("UPDATE categories SET archived = true, sort_order = sort_order + 100000 WHERE code = $1", [category.code]);
        if (!category.archived) lines.push(`archived  ${category.kind.padEnd(7)}  ${category.label}`);
      }

      const order = new Map<CategoryKind, number>();
      for (const { item, found } of plan) {
        const position = (order.get(item.kind) ?? 0) + 1;
        order.set(item.kind, position);
        const values = [item.label, position, item.requiresClient, item.requiresTrip, item.requiresCounterparty, item.requiresEmployee, item.city];
        if (found) {
          await client.query(
            `UPDATE categories SET label = $2, sort_order = $3, archived = false, requires_client = $4, requires_trip = $5,
                    requires_counterparty = $6, requires_employee = $7, city = $8 WHERE code = $1`,
            [found.code, ...values],
          );
          const was = found.label === item.label ? "" : ` (was «${found.label}»)`;
          lines.push(`${found.archived ? "restored" : "kept    "}  ${item.kind.padEnd(7)}  ${item.label}${was}`);
        } else {
          await client.query(
            `INSERT INTO categories (code, kind, label, sort_order, requires_client, requires_trip, requires_counterparty, requires_employee, city, notify_group)
             VALUES ($1, $9, $2, $3, $4, $5, $6, $7, $8, $9 = 'expense')`,
            [`c_${randomUUID().replaceAll("-", "").slice(0, 12)}`, ...values, item.kind],
          );
          lines.push(`added     ${item.kind.padEnd(7)}  ${item.label}`);
        }
      }
      // The archive after the lists, in the order it had.
      for (const kind of KINDS) {
        const archived = leaving.filter((category) => category.kind === kind);
        for (const [index, category] of archived.entries()) {
          await client.query("UPDATE categories SET sort_order = $2 WHERE code = $1", [category.code, (order.get(kind) ?? 0) + index + 1]);
        }
      }
      if (!taken.has("client_payment")) {
        lines.push('Note: no category of the file has "code": "client_payment". Only that category is the payment of a client: the one written to 1C, and the one an income is when it names none.');
      }
    });
  } catch (error) {
    // The name of a category of the file is the name of one in the archive that the file gave another name to.
    if ((error as { code?: string }).code === "23505") throw new AdminError("two categories of one list would have the same name: nothing was changed");
    throw error;
  }
  return lines;
}
