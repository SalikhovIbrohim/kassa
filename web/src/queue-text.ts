import { operationTitle, type Category, type OperationInput } from "./api";
import { formatMoney } from "./money";
import type { Problem } from "./queue";

/** What an entry says, in a few words: "Приход +5 000,00 ₽, клиент K17". */
export function entryText(input: OperationInput, categories: readonly Category[]): string {
  const sign = input.type === "income" ? "+" : "−";
  const kind = operationTitle(input.type, input.category ?? null, new Map(categories.map((item) => [item.code, item.label])));
  const who = input.clientCode
    ? `, клиент ${input.clientCode}`
    : input.type === "expense" && input.recipient
      ? `, ${input.recipient}`
      : "";
  return `${kind} ${sign}${formatMoney(input.amountMinor, input.currency)}${who}`;
}

/**
 * When an entry was made, by the clock of the phone (the cashier looks at that one): "12:27", and the
 * day too when it is not today.
 */
export function phoneTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (at.toDateString() === now.toDateString()) return time;
  return `${at.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })} ${time}`;
}

/** What the server's refusal means for the cashier, and what to do about it. */
export function problemText(problem: Problem): string {
  switch (problem.kind) {
    case "conflict":
      return "Похоже, такая запись уже есть на сервере. Проверьте «Журнал»: если она там, удалите эту.";
    case "forbidden":
      return "У вас нет права вносить операции.";
    case "rejected":
      return "Сервер не принял данные записи. Удалите её и внесите заново.";
  }
}
