import { useEffect, useState } from "react";
import { fetchClientSheet, fetchClientStatement, SessionExpiredError, type Client, type ClientStatement } from "./api";
import { formatUsd } from "./cargo";
import { feedOf, LATE_DAYS, LATE_OVER_MINOR, LONG_LATE_DAYS, shortDayOf } from "./client-list";
import { cashDayToday } from "./days";
import { useKassa } from "./kassa";
import { saveFile } from "./report-picture";
import { Icon } from "./sections";
import { alertVariants } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

/** Dollars and cents without the sign of the currency: "5 529,75". */
const sumOf = (minor: number) => formatUsd(Math.abs(minor)).replace(/\s*\$$/, "");

type Props = {
  client: Pick<Client, "code" | "name" | "phone" | "daysUnpaid">;
  /** The admin changes the client from the card. */
  onEdit?: () => void;
  onSessionExpired: () => void;
  /** The top block stays in sight while the lines under it scroll (a sheet); a panel beside the list has no need. */
  sticky?: boolean;
  /** The debt of the client has been read: whoever shows the card may want it. */
  className?: string;
};

/**
 * The card of a client, after the prototype of Express: what they owe now at the top, with what was charged and paid
 * in all and when they paid last; under it every truck and every payment, the newest first, month by month, each with
 * the debt after it; and at the end what they owed at the start. A truck adds to the debt (red, a plus), a payment
 * takes off it (green, a minus).
 */
export function ClientCard({ client, onEdit, onSessionExpired, sticky = true, className }: Props) {
  const { labelOf } = useKassa();
  // null: loading, undefined: did not load.
  const [statement, setStatement] = useState<ClientStatement | null | undefined>(null);
  const [saving, setSaving] = useState(false);
  const today = cashDayToday();

  useEffect(() => {
    let current = true;
    setStatement(null);
    fetchClientStatement(client.code).then(
      (loaded) => current && setStatement(loaded ?? undefined),
      (caught: unknown) => {
        if (!current) return;
        if (caught instanceof SessionExpiredError) onSessionExpired();
        else setStatement(undefined);
      },
    );
    return () => {
      current = false;
    };
  }, [client.code, onSessionExpired]);

  async function excel() {
    setSaving(true);
    try {
      saveFile(await fetchClientSheet(client.code), `klient-${client.code}.xlsx`);
    } catch (caught) {
      if (caught instanceof SessionExpiredError) onSessionExpired();
      else toast("Не получилось. Попробуйте ещё раз.");
    } finally {
      setSaving(false);
    }
  }

  if (statement === null) return <p className="hint">Загружаем…</p>;
  if (statement === undefined)
    return (
      <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
        Не удалось загрузить карточку. Проверьте связь и откройте её ещё раз.
      </p>
    );

  const debt = statement.debtMinor;
  const feed = feedOf(statement);
  const days = client.daysUnpaid ?? 0;
  const late = debt > LATE_OVER_MINOR && days >= LATE_DAYS;
  return (
    <div className={cn("grid min-w-0 gap-3", className)} data-client-card={client.code}>
      <div className={cn("grid gap-3 rounded-[22px] border bg-card px-4 py-3.5 shadow-sm", sticky && "sticky -top-1 z-[2] bg-background")} data-card-top>
        <div className="flex items-end justify-between gap-2.5">
          <div>
            <div className="mb-0.5 text-[12.5px] font-medium text-muted-foreground">{debt < 0 ? "Предоплата" : "Долг сейчас"}</div>
            <div className={cn("text-[30px] leading-[1.1] font-extrabold tracking-tight tabular-nums", debt > 0 ? "text-destructive" : debt < 0 ? "text-success" : "text-muted-foreground")} data-debt-now>
              {sumOf(debt)}
              <span className="ml-[.3em] text-[.5em] font-semibold">$</span>
            </div>
          </div>
          {late && (
            <span className={cn("inline-flex h-5 flex-none items-center rounded-[10px] px-2 text-[11px] font-semibold whitespace-nowrap", days >= LONG_LATE_DAYS ? "bg-destructive/12 text-destructive" : "bg-warning-bg text-warning")} data-days>
              {days} дн. без оплаты
            </span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2" data-card-values>
          {[
            ["Начислено", `${sumOf(feed.chargedMinor)} $`],
            ["Оплачено", `${sumOf(feed.paidMinor)} $`],
            ["Посл. оплата", feed.lastPaidDay ? shortDayOf(feed.lastPaidDay, today) : "не было"],
          ].map(([label, value]) => (
            <div key={label} className="grid min-w-0 gap-0.5 text-[13.5px] font-semibold tabular-nums">
              <span className="text-[11.5px] font-medium text-muted-foreground">{label}</span>
              <span className="truncate">{value}</span>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onEdit && (
            <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 px-3" onClick={onEdit}>
              <Icon name="edit" size={14} />
              Изменить
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 px-3" disabled={saving} onClick={() => void excel()}>
            <Icon name="down" size={14} />
            Excel
          </Button>
          {client.phone && <span className="inline-flex h-8 items-center rounded-full bg-muted px-3 text-[12.5px] font-semibold text-muted-foreground">{client.phone}</span>}
        </div>
      </div>

      {feed.months.length === 0 && <p className="hint mx-1.5">Рейсов и оплат у клиента пока нет.</p>}
      {feed.months.map((month) => (
        <div key={month.month} className="grid gap-2" data-feed-month={month.month}>
          <div className="mx-1.5 mt-1.5 text-[12px] font-semibold tracking-[.06em] text-muted-foreground uppercase">{month.title}</div>
          <div className="overflow-hidden rounded-[22px] border bg-card">
            {month.lines.map((line, index) => {
              const trip = line.kind === "trip";
              // A truck and money given back add to the debt; a payment takes off it.
              const adds = line.kind !== "payment";
              return (
                <div key={index} className="flex items-center gap-3 px-3.5 py-2.5 [&+div]:border-t" data-feed-line={line.kind}>
                  <span className={cn("grid size-8 flex-none place-items-center rounded-full", adds ? "bg-destructive/12 text-destructive" : "bg-success/12 text-success")}>
                    <Icon name={trip ? "trips" : adds ? "expense" : "income"} size={16} />
                  </span>
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate text-[15px] font-semibold">{trip ? `Рейс № ${line.tripNumber}` : line.kind === "refund" ? "Возврат клиенту" : "Оплата"}</span>
                    <span className="truncate text-[12.5px] text-muted-foreground">
                      {shortDayOf(line.day, today)}
                      {!trip && line.kassa ? ` · касса ${labelOf(line.kassa)}` : ""}
                      {line.note ? ` · ${line.note}` : ""}
                    </span>
                  </span>
                  <span className="grid flex-none justify-items-end gap-0.5">
                    <b className={cn("text-[15px] font-bold whitespace-nowrap tabular-nums", adds ? "text-destructive" : "text-success")}>
                      {adds ? "+" : "−"}
                      {sumOf(line.amountMinor)} $
                    </b>
                    <small className="text-[11.5px] whitespace-nowrap text-muted-foreground tabular-nums">
                      {line.debtMinor < 0 ? "предоплата " : "долг "}
                      {sumOf(line.debtMinor)} $
                    </small>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="overflow-hidden rounded-[22px] border bg-card" data-feed-opening>
        <div className="flex items-center gap-3 px-3.5 py-2.5">
          <span className="grid size-8 flex-none place-items-center rounded-full bg-accent text-muted-foreground">
            <Icon name="journal" size={16} />
          </span>
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="truncate text-[15px] font-semibold">Долг на начало</span>
            <span className="truncate text-[12.5px] text-muted-foreground">до первого рейса и первой оплаты</span>
          </span>
          <b className="flex-none text-[15px] font-bold whitespace-nowrap tabular-nums">
            {statement.openingDebtMinor < 0 ? "−" : ""}
            {sumOf(statement.openingDebtMinor)} $
          </b>
        </div>
      </div>
    </div>
  );
}
