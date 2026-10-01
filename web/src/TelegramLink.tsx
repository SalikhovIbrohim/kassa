import { useState } from "react";
import { linkTelegram, NetworkError } from "./api";
import { telegramLaunchData } from "./telegram";

/**
 * Inside Telegram, for a login whose Telegram is not linked yet: one button that links it, after which the Mini App
 * opens without a password. The launch data exists only inside Telegram, so this is the only place to do it.
 */
export function TelegramLink() {
  const [state, setState] = useState<"ask" | "busy" | "linked">("ask");
  const [problem, setProblem] = useState<string | null>(null);
  const launch = telegramLaunchData();
  if (!launch) return null;

  async function link() {
    setState("busy");
    setProblem(null);
    try {
      const result = await linkTelegram(launch!);
      if (result === "linked") {
        setState("linked");
        return;
      }
      setProblem(
        {
          taken: "Этот Telegram уже привязан к другому логину.",
          invalid: "Telegram не подтвердил запуск (данные устарели). Закройте приложение и откройте его снова.",
          failed: "Не получилось привязать. Попробуйте ещё раз.",
        }[result],
      );
    } catch (caught) {
      setProblem(caught instanceof NetworkError ? "Нет связи с сервером. Попробуйте ещё раз." : "Не получилось привязать. Попробуйте ещё раз.");
    }
    setState("ask");
  }

  if (state === "linked") {
    return (
      <p className="telegram-link" role="status">
        Telegram привязан: в следующий раз Касса откроется без пароля.
      </p>
    );
  }

  return (
    <section className="telegram-link" aria-label="Telegram">
      <span>Этот Telegram не привязан к вашему входу. Привяжите, и пароль больше не понадобится.</span>
      <button type="button" className="small" disabled={state === "busy"} onClick={() => void link()}>
        {state === "busy" ? "Привязываем…" : "Привязать Telegram"}
      </button>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
