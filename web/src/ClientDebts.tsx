import { useMemo, useState } from "react";
import type { Client } from "./api";
import { hintOf, isLate, LONG_LATE_DAYS, shownClients, totalsOf, type ClientFilter, type ClientSort } from "./client-list";
import { cashDayToday } from "./days";
import { plural } from "./plural";
import { Icon } from "./sections";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";

const FILTERS: ReadonlyArray<{ value: ClientFilter; label: string }> = [
  { value: "debtors", label: "Должники" },
  { value: "all", label: "Все" },
  { value: "late", label: "30+ дней" },
];
const SORTS: Record<ClientSort, string> = { debt: "По долгу", code: "По коду", days: "Кто дольше не платит" };
const NEXT_SORT: Record<ClientSort, ClientSort> = { debt: "code", code: "days", days: "debt" };

/** Whole dollars, the thousands apart, as the prototype writes money in a list: "28 574". The card of a client has the cents. */
const sumOf = (minor: number) => String(Math.round(Math.abs(minor) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");

/** A sum of dollars, the «$» small and a little apart, as the prototype writes money. */
function Usd({ minor, className }: { minor: number; className?: string }) {
  return (
    <span className={cn("tabular-nums whitespace-nowrap", className)}>
      {sumOf(minor)}
      <span className="ml-[.3em] text-[.62em] font-semibold">$</span>
    </span>
  );
}

/**
 * The clients of a business that keeps trips, as the prototype of Express has them: what all owe together, a search,
 * who to show (those who owe, everybody, those who do not pay), and a line to a client: the code on a tile, the name,
 * when they paid last and when their last truck came, and at the right what they owe. A tap opens the card.
 */
export function ClientDebts({ clients, onOpen }: { clients: readonly Client[]; onOpen: (client: Client) => void }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ClientFilter>("debtors");
  const [sort, setSort] = useState<ClientSort>("debt");
  const today = cashDayToday();
  const totals = useMemo(() => totalsOf(clients), [clients]);
  const shown = useMemo(() => shownClients(clients, { filter, sort, search }), [clients, filter, sort, search]);
  const typed = search.trim();

  return (
    <div className="grid min-w-0 gap-3" data-client-debts>
      <div className="glass-card grid gap-1.5 rounded-[26px] px-[18px] pt-[18px] pb-3.5" data-debts>
        <div className="text-[13px] font-medium text-muted-foreground">Должны всего</div>
        <Usd minor={totals.owedMinor} className="text-[38px] leading-[1.05] font-extrabold tracking-tight text-destructive" />
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13.5px] text-muted-foreground">
          <span data-debtors>
            <b className="font-semibold text-foreground tabular-nums">{totals.debtors}</b> {plural(totals.debtors, "должник", "должника", "должников")}
          </span>
          {totals.aheadMinor > 0 && (
            <span data-ahead>
              Предоплаты <Usd minor={totals.aheadMinor} className="font-semibold text-success" />
            </span>
          )}
        </div>
        {totals.late > 0 && (
          <button
            type="button"
            className="mt-2 flex w-full items-center gap-2 rounded-2xl bg-warning-bg px-3 py-2.5 text-left text-[13.5px] font-semibold text-warning"
            data-late
            onClick={() => setFilter("late")}
          >
            <span aria-hidden="true" className="grid size-[18px] flex-none place-items-center rounded-full border-[1.6px] border-current text-[11px] leading-none font-bold">
              !
            </span>
            <span className="min-w-0 flex-1">
              Не платят 30+ дней: {totals.late} · {sumOf(totals.lateMinor)} $
            </span>
            <Icon name="chevronRight" size={16} stroke={2.2} />
          </button>
        )}
      </div>

      <div className="grid gap-2.5">
        <Input type="search" name="search" aria-label="Поиск" placeholder="Код, имя или телефон" className="h-11 rounded-full px-5" value={search} onChange={(event) => setSearch(event.target.value)} />
        <Segmented label="Кого показать" value={filter} onChange={setFilter} options={FILTERS} />
      </div>

      <div className="mx-1.5 flex items-center justify-between gap-2 text-[12px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
        <span data-count>
          Показано: {shown.length} из {clients.length}
        </span>
        <button
          type="button"
          className="inline-flex h-[30px] items-center gap-1.5 rounded-full bg-muted px-2.5 text-[13px] font-semibold tracking-normal text-foreground normal-case"
          aria-label={`Сортировка: ${SORTS[sort]}`}
          data-sort={sort}
          onClick={() => setSort(NEXT_SORT[sort])}
        >
          <Icon name="down" size={14} stroke={2.2} />
          {SORTS[sort]}
        </button>
      </div>

      {shown.length === 0 ? (
        <div className="glass-card grid gap-1 rounded-[26px] px-5 py-8 text-center" data-empty>
          <b className="text-[15px]">{typed ? "Ничего не найдено" : "Здесь пусто"}</b>
          <span className="text-[13.5px] text-muted-foreground">
            {typed ? `По запросу «${typed}» клиентов нет.` : filter === "late" ? "Никто не задерживает оплату дольше 30 дней." : filter === "debtors" ? "Должников нет." : "Клиентов пока нет."}
          </span>
        </div>
      ) : (
        <ul className="glass-card overflow-hidden rounded-[26px]">
          {shown.map((client) => {
            const debt = client.debtMinor ?? 0;
            const late = isLate(client);
            return (
              <li key={client.code} className="relative [&+li]:before:absolute [&+li]:before:top-0 [&+li]:before:right-0 [&+li]:before:left-[84px] [&+li]:before:h-px [&+li]:before:bg-border">
                <button
                  type="button"
                  className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60"
                  data-client={client.code}
                  aria-label={`Карточка: ${client.code} ${client.name}`}
                  onClick={() => onOpen(client)}
                >
                  <span className="grid h-[38px] min-w-14 flex-none place-items-center rounded-xl bg-accent px-2 text-[13px] font-bold text-muted-foreground tabular-nums">{client.code}</span>
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className={cn("truncate text-[15px] font-semibold", !client.active && "text-muted-foreground line-through")}>{client.name || "без имени"}</span>
                    <span className="truncate text-[12.5px] text-muted-foreground" data-hint>
                      {hintOf(client, today)}
                    </span>
                  </span>
                  <span className="grid flex-none justify-items-end gap-[3px] text-right" data-debt>
                    <Usd minor={Math.abs(debt)} className={cn("text-base font-bold", debt > 0 ? "text-destructive" : debt < 0 ? "text-success" : "text-muted-foreground")} />
                    {late ? (
                      <span
                        className={cn(
                          "inline-flex h-5 items-center rounded-[10px] px-2 text-[11px] font-semibold whitespace-nowrap",
                          (client.daysUnpaid ?? 0) >= LONG_LATE_DAYS ? "bg-destructive/12 text-destructive" : "bg-warning-bg text-warning",
                        )}
                        data-days
                      >
                        {client.daysUnpaid} дн.
                      </span>
                    ) : (
                      debt < 0 && <small className="text-[11.5px] text-muted-foreground">предоплата</small>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
