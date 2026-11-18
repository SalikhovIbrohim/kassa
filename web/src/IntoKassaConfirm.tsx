import { useCallback, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

/** A city in «касса Ташкента», «в кассу Ташкента»: the cities the business has are known, any other is named as it is. */
export function ofCity(label: string): string {
  const known: Record<string, string> = { Москва: "Москвы", Андижан: "Андижана", Ташкент: "Ташкента", Коканд: "Коканда" };
  return known[label] ?? `«${label}»`;
}

type Asked = {
  /** «Приход 600,00 $». */
  what: string;
  /** The desk the money goes into, and the desk the person works in: «Ташкент», «Москва». */
  into: string;
  own: string;
};

/**
 * The question before an entry is written into another cash desk than the one the person works in (a category that
 * sends its money there, see `Category.intoKassa`): the cashier of Moscow who writes down what the owner took in
 * Tashkent is told, every time, that this is money of Tashkent and not of Moscow. `ask` answers true when they go on.
 */
export function useIntoKassaConfirm(): { ask: (asked: Asked) => Promise<boolean>; dialog: ReactNode } {
  const [asked, setAsked] = useState<Asked | null>(null);
  const answer = useRef<((go: boolean) => void) | null>(null);

  const ask = useCallback((next: Asked) => {
    // A question still open is answered «нет» by the next one.
    answer.current?.(false);
    setAsked(next);
    return new Promise<boolean>((resolve) => {
      answer.current = resolve;
    });
  }, []);
  const close = (go: boolean) => {
    answer.current?.(go);
    answer.current = null;
    setAsked(null);
  };

  const dialog = (
    <Dialog open={asked !== null} onOpenChange={(open) => !open && close(false)}>
      <DialogContent data-into-kassa>
        <DialogTitle>Это деньги кассы {asked ? ofCity(asked.into) : ""}</DialogTitle>
        <DialogDescription asChild>
          <div className="grid gap-2 text-[15px] leading-snug">
            <p>
              {asked?.what} будет записан в кассу <strong>{asked ? ofCity(asked.into) : ""}</strong>, а не {asked ? ofCity(asked.own) : ""}.
            </p>
            <p className="text-muted-foreground">
              Остаток кассы {asked ? ofCity(asked.own) : ""} не изменится: этих денег в ней нет.
            </p>
          </div>
        </DialogDescription>
        <div className="flex flex-wrap gap-2">
          <Button type="button" autoFocus onClick={() => close(true)}>
            Да, записать в кассу {asked ? ofCity(asked.into) : ""}
          </Button>
          <Button type="button" variant="outline" onClick={() => close(false)}>
            Отмена
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
  return { ask, dialog };
}
