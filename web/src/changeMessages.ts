import type { ChangeResult } from "./api";
import type { Currency } from "./money";
import { formatMoney } from "./money";

const CURRENCY_IN: Record<Currency, string> = { RUB: "рублях", USD: "долларах" };

type Failure = Extract<ChangeResult, { ok: false }>;

/** What to tell the cashier when a correction or a deletion did not go through. */
export function explainFailure(failure: Failure, action: "edit" | "delete"): string {
  switch (failure.reason) {
    case "would-go-negative": {
      const after = formatMoney(failure.balanceAfterMinor, failure.currency);
      return action === "delete"
        ? `Нельзя удалить: из этих денег уже что-то потрачено, остаток в ${CURRENCY_IN[failure.currency]} стал бы ${after}.`
        : `Нельзя сохранить: остаток в ${CURRENCY_IN[failure.currency]} стал бы ${after}. Уменьшите сумму или сначала внесите недостающий приход.`;
    }
    case "deleted":
      return "Эта запись уже удалена.";
    case "forbidden":
      return "Это не ваша запись, менять её нельзя.";
    case "not-found":
      return "Такой записи нет. Обновите журнал.";
    case "session-expired":
      return "Нужно войти заново.";
    case "rejected":
      return "Проверьте данные и попробуйте ещё раз.";
  }
}

export const NO_CONNECTION =
  "Нет связи с сервером. Ничего не потеряно: нажмите кнопку ещё раз, когда появится интернет, повтор безопасен.";
