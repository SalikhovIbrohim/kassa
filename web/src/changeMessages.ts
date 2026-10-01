import type { ChangeResult } from "./api";
import type { Currency } from "./money";
import { formatMoney } from "./money";

const CURRENCY_IN: Record<Currency, string> = { RUB: "рублях", USD: "долларах" };

type Failure = Extract<ChangeResult, { ok: false }>;

/**
 * What to tell the cashier when a correction or a deletion did not go through. For a
 * correction the advice depends on what is being corrected: money that came in and was
 * spent cannot be lowered, money that went out can be lowered.
 */
export function explainFailure(failure: Failure, action: "edit" | "delete", type?: "income" | "expense"): string {
  switch (failure.reason) {
    case "would-go-negative": {
      const in_ = CURRENCY_IN[failure.currency];
      const after = formatMoney(failure.balanceAfterMinor, failure.currency);
      if (action === "delete") {
        return `Нельзя удалить: из этих денег уже что-то потрачено, остаток в ${in_} стал бы ${after}.`;
      }
      return type === "income"
        ? `Нельзя сохранить: из этих денег уже что-то потрачено, остаток в ${in_} стал бы ${after}. Оставьте сумму побольше и не меняйте валюту.`
        : `Нельзя сохранить: остаток в ${in_} стал бы ${after}. Уменьшите сумму или сначала внесите недостающий приход.`;
    }
    case "deleted":
      return "Эта запись уже удалена.";
    case "forbidden":
      return "Это не ваша запись, менять её нельзя.";
    case "not-found":
      return "Такой записи нет. Обновите журнал.";
    case "session-expired":
      return "Нужно войти заново.";
    case "server-error":
      return SERVER_FAILED;
    case "rejected":
      return "Проверьте данные и попробуйте ещё раз.";
  }
}

export const NO_CONNECTION =
  "Нет связи с сервером. Ничего не потеряно: нажмите кнопку ещё раз, когда появится интернет, повтор безопасен.";

/** The server answered, but with a failure of its own: not the person's mistake, safe to retry. */
export const SERVER_FAILED =
  "Сервер сейчас не справился. Ничего не потеряно: нажмите кнопку ещё раз, повтор безопасен.";
