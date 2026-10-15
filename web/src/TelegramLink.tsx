import { useState } from "react";
import { linkTelegram, NetworkError } from "./api";
import { telegramLaunchData } from "./telegram";
import { Button } from "@/components/ui/button";
import { alertVariants } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

/**
 * Inside Telegram, for a login whose Telegram is not linked yet: one button in the menu that links it, after which the
 * Mini App opens without a password. The launch data exists only inside Telegram, so this is the only place to do it.
 */
export function TelegramLink({ onLinked }: { onLinked: () => void }) {
  const [state, setState] = useState<"ask" | "busy">("ask");
  const [problem, setProblem] = useState<string | null>(null);
  const launch = telegramLaunchData();
  if (!launch) return null;

  async function link() {
    setState("busy");
    setProblem(null);
    try {
      const result = await linkTelegram(launch!);
      if (result === "linked") {
        onLinked();
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

  return (
    <section className="grid gap-2" aria-label="Telegram">
      <span className="text-xs text-muted-foreground">Telegram не привязан: после привязки пароль не понадобится.</span>
      <Button type="button" size="sm" variant="outline" className="w-full" disabled={state === "busy"} onClick={() => void link()}>
        {state === "busy" ? "Привязываем…" : "Привязать Telegram"}
      </Button>
      {problem && (
        <p className={cn(alertVariants({ variant: "destructive" }), "error text-sm")} role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
