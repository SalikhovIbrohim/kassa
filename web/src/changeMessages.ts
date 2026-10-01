import type { ChangeResult } from "./api";
type Failure = Extract<ChangeResult, { ok: false }>;

/** What to tell the cashier when a correction or a deletion did not go through. */
export function explainFailure(failure: Failure): string {
  switch (failure.reason) {
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
