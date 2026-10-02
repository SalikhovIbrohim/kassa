import type pg from "pg";
import { DEFAULT_INCOME_CATEGORY, readCategories, type Category } from "./categories.js";
import { type LedgerEvents, type OperationRow, type Snapshot } from "./ledger.js";
import { toUsdMinor, type Currency } from "./money.js";
import type { Outbox } from "./outbox.js";

const money = (minor: number, currency: Currency) => new Intl.NumberFormat("ru-RU", { style: "currency", currency }).format(minor / 100);

/** 790000 -> "79,00", 782345 -> "78,2345". */
function rate(rateE4: number): string {
  const whole = Math.floor(rateE4 / 10_000);
  const fraction = String(rateE4 % 10_000).padStart(4, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole},${fraction}`;
}

/** "1 185,00 ₽ · курс 79,00 · ≈ 15,00 $" for rubles that have a rate; the plain amount otherwise. */
function amountLine(entry: { amountMinor: number; currency: Currency; rateE4: number | null }): string {
  const plain = money(entry.amountMinor, entry.currency);
  if (entry.currency !== "RUB" || entry.rateE4 === null) return plain;
  return `${plain} · курс ${rate(entry.rateE4)} · ≈ ${money(toUsdMinor(entry.amountMinor, entry.rateE4), "USD")}`;
}

/** "05.03 11:30 МСК" by the clock of the cash desk (Moscow). */
function moscowTime(instant: Date): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("day")}.${part("month")} ${part("hour")}:${part("minute")} МСК`;
}

const because = (reason: string | null) => (reason ? ` (причина: ${reason})` : "");

function snapshotOfRow(row: OperationRow): Snapshot {
  return {
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    rateE4: row.rate_e4 === null ? null : Number(row.rate_e4),
    category: row.category,
    recipient: row.recipient,
    clientCode: row.client_code,
    comment: row.comment,
  };
}

/** What the entry is called in the group: "Приход от клиента A406", "Приход «Взяли долг»", "Расход «Оплата фура»". */
function headline(kind: "income" | "expense", entry: Snapshot, categories: readonly Category[]): string {
  // An income of before there were categories of income is a payment of a client.
  const code = entry.category ?? (kind === "income" ? DEFAULT_INCOME_CATEGORY : null);
  const label = categories.find((item) => item.code === code)?.label ?? code ?? "";
  if (kind === "income" && code === DEFAULT_INCOME_CATEGORY) return `Приход от клиента ${entry.clientCode ?? ""}`.trim();
  const client = entry.clientCode ? ` (клиент ${entry.clientCode})` : "";
  return `${kind === "income" ? "Приход" : "Расход"} «${label}»${client}`;
}

/** The lines that say what the entry is, apart from its amount: who it went to, what was said. */
function details(entry: Snapshot): string[] {
  return [entry.recipient ? `Кому: ${entry.recipient}` : "", entry.comment ? `Комментарий: ${entry.comment}` : ""].filter(Boolean);
}

function createdText(row: OperationRow, categories: readonly Category[]): string {
  const entry = snapshotOfRow(row);
  const who = row.kind === "income" ? "Принял" : "Выдал";
  return [
    `${row.kind === "income" ? "💰" : "💸"} ${headline(row.kind, entry, categories)}`,
    amountLine(entry),
    ...details(entry),
    `${who}: ${row.author_display_name}, ${moscowTime(row.created_at)}`,
  ].join("\n");
}

/** What differs between two versions of an entry, besides the amount. */
function differences(before: Snapshot, after: Snapshot, categories: readonly Category[]): string[] {
  const label = (code: string | null) => categories.find((item) => item.code === code)?.label ?? code ?? "без категории";
  const lines: string[] = [];
  if (before.category !== after.category) lines.push(`Категория: было «${label(before.category)}», стало «${label(after.category)}»`);
  if (before.clientCode !== after.clientCode) lines.push(`Клиент: было ${before.clientCode ?? "без кода"}, стало ${after.clientCode ?? "без кода"}`);
  if (before.recipient !== after.recipient) lines.push(`Кому: было «${before.recipient ?? ""}», стало «${after.recipient ?? ""}»`);
  if (before.comment !== after.comment) lines.push(`Комментарий: было «${before.comment ?? ""}», стало «${after.comment ?? ""}»`);
  return lines;
}

/**
 * The messages for the Telegram group: written down, with the operation, when an entry of a category that the owner
 * wants the group told of is made, corrected or deleted. The incomes go to one topic of the group and the expenses to
 * another (see `Outbox.queue`). Without a group set up there is nothing to tell and no events.
 */
export function groupEvents(outbox: Outbox): LedgerEvents | undefined {
  if (!outbox.enabled) return undefined;

  const nameOf = async (db: pg.PoolClient, userId: string) =>
    (await db.query<{ display_name: string }>("SELECT display_name FROM users WHERE id = $1", [userId])).rows[0]?.display_name ?? "?";

  /** Whether the group is told of this category: an income without one is a payment of a client. */
  const told = (categories: readonly Category[], kind: "income" | "expense", code: string | null) => {
    const wanted = code ?? (kind === "income" ? DEFAULT_INCOME_CATEGORY : null);
    return categories.find((item) => item.code === wanted)?.notifyGroup ?? false;
  };

  return {
    async created(db, row) {
      const categories = await readCategories(db);
      if (told(categories, row.kind, row.category)) await outbox.queue(db, createdText(row, categories), row.id, row.kind);
    },

    async changed(db, event) {
      const { before, row, action } = event;
      const categories = await readCategories(db);
      const wasTold = told(categories, row.kind, before.category);
      const isTold = told(categories, row.kind, row.category);
      if (!wasTold && !(action === "edit" && isTold)) return;
      const who = await nameOf(db, event.actorId);
      const when = moscowTime(event.at);

      if (action === "delete") {
        await outbox.queue(
          db,
          [`🗑 Удалено: ${headline(row.kind, before, categories)}`, `Было: ${amountLine(before)}`, `Удалил: ${who}, ${when}${because(event.reason)}`].join("\n"),
          row.id,
          row.kind,
        );
        return;
      }

      const after = snapshotOfRow(row);
      if (wasTold && isTold) {
        await outbox.queue(
          db,
          [
            `✏️ Исправлено: ${headline(row.kind, before, categories)}`,
            `Было: ${amountLine(before)}`,
            `Стало: ${amountLine(after)}`,
            ...differences(before, after, categories),
            `Исправил: ${who}, ${when}${because(event.reason)}`,
          ].join("\n"),
          row.id,
          row.kind,
        );
      } else if (wasTold) {
        await outbox.queue(
          db,
          [
            `✏️ Исправлено: ${headline(row.kind, before, categories)} теперь «${categories.find((item) => item.code === row.category)?.label ?? row.category}», о ней группе не сообщаем`,
            `Было: ${amountLine(before)}`,
            `Исправил: ${who}, ${when}${because(event.reason)}`,
          ].join("\n"),
          row.id,
          row.kind,
        );
      } else {
        await outbox.queue(db, `${createdText(row, categories)}\n(внесено исправлением записи: ${who}${because(event.reason)})`, row.id, row.kind);
      }
    },
  };
}
