import type pg from "pg";
import { DEFAULT_INCOME_CATEGORY } from "./categories.js";
import { type LedgerEvents, type OperationRow, type Snapshot } from "./ledger.js";
import { toUsdMinor, type Currency } from "./money.js";
import type { Outbox } from "./outbox.js";

/** An income of a client: the category of payments of clients, and the incomes of before there were categories (those are payments too). */
function isClientPayment(kind: "income" | "expense", category: string | null): boolean {
  return kind === "income" && (category === null || category === DEFAULT_INCOME_CATEGORY);
}

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

/** "05.03 11:30" by the clock of the cash desk (Moscow). */
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
const comment = (text: string | null) => (text ? `\nКомментарий: ${text}` : "");

export function createdText(row: OperationRow): string {
  const rateE4 = row.rate_e4 === null ? null : Number(row.rate_e4);
  return (
    `💰 Приход от клиента ${row.client_code ?? ""}\n` +
    `${amountLine({ amountMinor: Number(row.amount_minor), currency: row.currency, rateE4 })}\n` +
    `Принял: ${row.author_display_name}, ${moscowTime(row.created_at)}` +
    comment(row.comment)
  );
}

function changedText(before: Snapshot, after: Snapshot, who: string, why: string | null, at: Date): string {
  const lines = [`✏️ Исправлен приход от клиента ${after.clientCode ?? before.clientCode ?? ""}`];
  if (before.clientCode !== after.clientCode) lines.push(`Клиент: было ${before.clientCode ?? "без кода"}, стало ${after.clientCode ?? "без кода"}`);
  lines.push(`Было: ${amountLine(before)}`, `Стало: ${amountLine(after)}`);
  if (before.comment !== after.comment) lines.push(`Комментарий: было «${before.comment ?? ""}», стало «${after.comment ?? ""}»`);
  lines.push(`Исправил: ${who}, ${moscowTime(at)}${because(why)}`);
  return lines.join("\n");
}

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

/**
 * The messages for the Telegram group about the incomes of clients: written down, with the operation, when one is
 * entered, corrected or deleted. Nothing else goes to the group (not the expenses, not the other incomes). Without a
 * group set up there is nothing to tell and no events.
 */
export function clientIncomeEvents(outbox: Outbox): LedgerEvents | undefined {
  if (!outbox.enabled) return undefined;

  const nameOf = async (db: pg.PoolClient, userId: string) =>
    (await db.query<{ display_name: string }>("SELECT display_name FROM users WHERE id = $1", [userId])).rows[0]?.display_name ?? "?";

  return {
    async created(db, row) {
      if (isClientPayment(row.kind, row.category)) await outbox.queue(db, createdText(row), row.id);
    },

    async changed(db, event) {
      const { before, row, action } = event;
      const wasClientPayment = isClientPayment(row.kind, before.category);
      if (!wasClientPayment && !(action === "edit" && isClientPayment(row.kind, row.category))) return;
      const who = await nameOf(db, event.actorId);

      if (action === "delete") {
        await outbox.queue(
          db,
          `🗑 Удалён приход от клиента ${before.clientCode ?? ""}\nБыло: ${amountLine(before)}\nУдалил: ${who}, ${moscowTime(event.at)}${because(event.reason)}`,
          row.id,
        );
        return;
      }

      const isNow = isClientPayment(row.kind, row.category);
      if (wasClientPayment && isNow) {
        await outbox.queue(db, changedText(before, snapshotOfRow(row), who, event.reason, event.at), row.id);
      } else if (wasClientPayment) {
        const label = (await db.query<{ label: string }>("SELECT label FROM categories WHERE code = $1", [row.category])).rows[0]?.label ?? row.category;
        await outbox.queue(
          db,
          `✏️ Приход ${before.clientCode ?? ""} больше не оплата от клиента: теперь «${label}»\nБыло: ${amountLine(before)}\nИсправил: ${who}, ${moscowTime(event.at)}${because(event.reason)}`,
          row.id,
        );
      } else {
        await outbox.queue(db, `${createdText(row)}\n(внесён исправлением записи: ${who}${because(event.reason)})`, row.id);
      }
    },
  };
}
