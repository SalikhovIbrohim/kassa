import { useState, type Ref } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

type Props = {
  displayName: string;
  roleLabel: string;
  onJournal: () => void;
  /** The admin's way to «Управление»; nobody else has it. */
  onManage?: () => void;
  onLeave: () => void;
  menuButton?: Ref<HTMLButtonElement>;
};

/**
 * The top of the cash desk, as small as it can be: who is working, and ☰ with what is not needed at every entry
 * (the journal, the admin's «Управление», leaving).
 */
export function CashMenu({ displayName, roleLabel, onJournal, onManage, onLeave, menuButton }: Props) {
  const [open, setOpen] = useState(false);
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const item = "flex h-11 items-center rounded-[10px] px-3 text-left text-sm font-semibold text-foreground/80 hover:bg-muted";

  return (
    <header className="flex items-center justify-between gap-3">
      {/* The classes "who" and "role" are hooks for the tests of the browser. */}
      <p className="who m-0 flex min-w-0 flex-wrap items-center gap-2 text-lg font-semibold">
        <span className="truncate">{displayName}</span>
        <Badge className="role">{roleLabel}</Badge>
      </p>
      <Button ref={menuButton} type="button" variant="ghost" size="icon" className="size-10 text-xl" aria-label="Меню" onClick={() => setOpen(true)}>
        ☰
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-0 right-0 left-auto flex h-dvh max-h-dvh w-[280px] max-w-[85vw] translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 border-l bg-card px-3 py-4">
          <DialogTitle className="sr-only">Меню</DialogTitle>
          <DialogDescription className="sr-only">Журнал и выход</DialogDescription>
          <nav aria-label="Меню кассы" className="mt-10 grid gap-0.5">
            <button type="button" className={item} onClick={pick(onJournal)}>
              Журнал
            </button>
            {onManage && (
              <button type="button" className={item} onClick={pick(onManage)}>
                Управление
              </button>
            )}
          </nav>
          <div className="mt-auto flex items-center justify-between gap-2 border-t p-3">
            <span className="grid gap-1">
              <span className="font-semibold">{displayName}</span>
              <Badge className="w-fit">{roleLabel}</Badge>
            </span>
            <Button type="button" variant="outline" size="sm" onClick={pick(onLeave)}>
              Выйти
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </header>
  );
}
