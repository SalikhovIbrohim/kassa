import { useEffect, useRef, useState, type ReactNode } from "react";
import { fetchDebtReport, fetchUnpaidSheet, SessionExpiredError, type DebtReport } from "./api";
import { ClientCard } from "./ClientCard";
import { cashDayToday, shiftDay } from "./days";
import {
  backdatedNote,
  BARS_SHOWN,
  changeCaption,
  chargedCaption,
  clientsCount,
  controlNotes,
  dayNear,
  dynamicsNotes,
  formatCents,
  formatChange,
  formatWhole,
  monthName,
  movementNotes,
  neverPaid,
  overdueNotes,
  paidCaption,
  periodDays,
  periodLabel,
  restLine,
  shortDay,
  topNotes,
  yearDay,
} from "./debt-report";
import { Dynamics } from "./DebtDynamics";
import { useKassa } from "./kassa";
import { plural } from "./plural";
import { BLOCK_CSS, givePictures, PICTURE_WIDTH, pictureOf, saveFile } from "./report-picture";
import { Icon } from "./sections";
import { Button } from "@/components/ui/button";
import { alertVariants } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

type Props = {
  onSessionExpired: () => void;
  /** The screen is on show: a hidden one asks for nothing, and asks again when it comes back. */
  active?: boolean;
};

/** What the day is compared with: the day before, a week back, a month back. */
type Span = 1 | 7 | 30;
const SPANS: ReadonlyArray<{ days: Span; label: string }> = [
  { days: 1, label: "За день" },
  { days: 7, label: "За 7 дней" },
  { days: 30, label: "За 30 дней" },
];
/** How many lines a card shows of those who paid and were charged, of those who owe most while folded, and of those who do not pay. */
const ROWS_SHOWN = 6;
const TOP_FOLDED = 8;
const OVERDUE_SHOWN = 12;

/** The pictures, in the order they are shown and sent. */
const PICTURES = [
  { key: "movement", title: "Изменение долга", file: "1-izmenenie-dolga" },
  { key: "top", title: "Топ-30 должников", file: "2-top-30" },
  { key: "overdue", title: "Долго не платят", file: "3-dolgo-ne-platyat" },
  { key: "control", title: "Контроль по месяцам", file: "4-kontrol" },
  // Only on the last day of a month.
  { key: "dynamics", title: "Динамика за месяц", file: "5-dinamika" },
] as const;
type PictureKey = (typeof PICTURES)[number]["key"];

/**
 * «Отчёты»: the debts of the clients for a day of the cash desk, after the prototype of Express. The day is stepped
 * through with arrows and compared with the day before, a week or a month back; four numbers say how the debt moved;
 * then who paid, who was charged, who owes most and who has not paid for long, each line a client whose card a tap
 * opens. The pictures the business sends on are made of the same report only when they are asked for.
 */
export function DebtReports({ onSessionExpired, active = true }: Props) {
  // Worked out again on every render: a page left open overnight must still know what day it is.
  const today = cashDayToday();
  const [day, setDay] = useState(today);
  // How many days back the day is compared with: the day before, a week, a month.
  const [span, setSpan] = useState<Span>(1);
  // null: loading; undefined: failed.
  const [report, setReport] = useState<DebtReport | null | undefined>(null);
  const [stale, setStale] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [busy, setBusy] = useState<"pictures" | "sheet" | null>(null);
  // The whole list of thirty, or its first eight.
  const [allTop, setAllTop] = useState(false);
  // The client whose card is open.
  const [card, setCard] = useState<{ code: string; name: string; daysUnpaid?: number } | null>(null);
  const pictures = useRef<Partial<Record<PictureKey, HTMLDivElement | null>>>({});
  const { labelOf } = useKassa();
  const since = shiftDay(day, -span);

  useEffect(() => {
    if (!active) return;
    let current = true;
    setStale(true);
    fetchDebtReport(day, since).then(
      (loaded) => {
        if (!current) return;
        setReport(loaded);
        setStale(false);
      },
      (caught: unknown) => {
        if (!current) return;
        if (caught instanceof SessionExpiredError) onSessionExpired();
        else {
          setReport(undefined);
          setStale(false);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [active, day, since, reloads, onSessionExpired]);

  const choose = (next: string) => {
    if (next && next <= today) setDay(next);
  };

  // The pictures for a chat are made only when asked for: the blocks are drawn off the screen, as they always looked,
  // turned into PNGs and handed over; then they are gone again.
  useEffect(() => {
    if (busy !== "pictures" || !report) return;
    let current = true;
    const frame = requestAnimationFrame(() => {
      void (async () => {
        try {
          const made: Array<{ blob: Blob; name: string }> = [];
          for (const picture of PICTURES) {
            const block = pictures.current[picture.key];
            if (block) made.push({ blob: await pictureOf(block), name: `dolgi-${report.day}-${picture.file}.png` });
          }
          if (current) await givePictures(made);
        } catch {
          toast("Не получилось. Попробуйте ещё раз.");
        } finally {
          if (current) setBusy(null);
        }
      })();
    });
    return () => {
      current = false;
      cancelAnimationFrame(frame);
    };
  }, [busy, report]);

  async function sheet() {
    setBusy("sheet");
    try {
      saveFile(await fetchUnpaidSheet(day), `ne-platyat-7-dney-${day}.xlsx`);
    } catch (caught) {
      if (caught instanceof SessionExpiredError) onSessionExpired();
      else toast("Не получилось. Попробуйте ещё раз.");
    } finally {
      setBusy(null);
    }
  }

  const ready = report !== null && report !== undefined;
  const open = (client: { code: string; name: string; daysUnpaid?: number }) => setCard(client);
  const many = ready && report.dynamics ? 5 : 4;

  return (
    <div className="grid w-full min-w-0 gap-3" data-debt-report aria-busy={stale}>
      <div className="glass-card flex items-center gap-2.5 rounded-[26px] px-3 py-2.5" data-day-switch>
        <Button type="button" variant="outline" size="icon" className="size-10 flex-none rounded-full" aria-label="Предыдущий день" onClick={() => choose(shiftDay(day, -1))}>
          <Icon name="chevronLeft" size={18} stroke={2.2} />
        </Button>
        <label className="grid min-w-0 flex-1 justify-items-center gap-0.5 text-center">
          <span className="sr-only">День</span>
          {/* The day is read and chosen in one place: a tap on it opens the calendar. */}
          <input
            type="date"
            name="day"
            className="w-full max-w-[11rem] bg-transparent text-center text-base font-bold outline-none"
            value={day}
            max={today}
            onChange={(event) => choose(event.target.value)}
          />
          <small className="text-[12px] text-muted-foreground">{day === today ? "сегодня, день кассы ещё открыт" : "день закрыт в 03:00 по Москве"}</small>
        </label>
        <Button type="button" variant="outline" size="icon" className="size-10 flex-none rounded-full" aria-label="Следующий день" disabled={day >= today} onClick={() => choose(shiftDay(day, 1))}>
          <Icon name="chevronRight" size={18} stroke={2.2} />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="За какой срок">
        {SPANS.map((item) => (
          <button
            key={item.days}
            type="button"
            aria-pressed={span === item.days}
            className={cn("h-9 rounded-full border px-3.5 text-[13.5px] font-semibold whitespace-nowrap", span === item.days ? "border-transparent bg-primary text-primary-foreground" : "bg-card text-muted-foreground")}
            onClick={() => setSpan(item.days)}
          >
            {item.label}
          </button>
        ))}
        <button type="button" className="ml-auto h-9 rounded-full px-2 text-[13px] font-semibold text-muted-foreground" onClick={() => setReloads((count) => count + 1)}>
          Обновить
        </button>
      </div>

      {report === null && <p className="hint">Загружаем…</p>}
      {report === undefined && (
        <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
          Не удалось загрузить отчёт. Проверьте связь и нажмите «Обновить».
        </p>
      )}
      {ready && (
        <div className={cn("grid min-w-0 gap-3 transition-opacity", stale && "opacity-60")}>
          <Tiles report={report} />
          {report.backdated && report.backdated.changes.length > 0 && (
            <p className="rounded-2xl bg-warning-bg px-3.5 py-2.5 text-[13px] leading-snug text-warning" data-backdated>
              {backdatedNote(report)}
            </p>
          )}
          <div className="grid min-w-0 items-start gap-3 min-[880px]:grid-cols-2">
            <Block title="Кто оплатил" count={report.payers.length > 0 ? `${formatWhole(report.paidMinor)} $` : ""} none="За этот период оплат не было." name="paid" empty={report.payers.length === 0}>
              <Rows rows={report.payers.slice(0, ROWS_SHOWN).map((payer) => ({ ...payer, tags: payer.kassas.map((kassa) => labelOf(kassa)) }))} tone="paid" onOpen={open} />
              <More left={report.payers.length - ROWS_SHOWN} />
            </Block>
            <Block title="Кому начислено" count={report.charged.length > 0 ? `${formatWhole(report.chargedMinor)} $` : ""} none="За этот период рейсы не приходили." name="charged" empty={report.charged.length === 0}>
              <Rows rows={report.charged.slice(0, ROWS_SHOWN).map((client) => ({ ...client, tags: [`рейс ${client.trips.join(", ")}`] }))} tone="charged" onOpen={open} />
              <More left={report.charged.length - ROWS_SHOWN} />
            </Block>
            <Block title={report.debtors.count > TOP_FOLDED ? `Топ-${allTop ? report.top.rows.length : TOP_FOLDED} должников` : "Должники"} count={`${report.debtors.count} всего`} none="Должников нет." name="top" empty={report.top.rows.length === 0}>
              <Rows
                rows={report.top.rows.slice(0, allTop ? undefined : TOP_FOLDED).map((row) => ({
                  code: row.code,
                  name: row.name,
                  amountMinor: row.debtMinor,
                  place: row.place,
                  daysUnpaid: row.daysUnpaid,
                  sub: Math.round(Math.abs(row.changeMinor) / 100) === 0 ? undefined : { left: "за период", right: `${formatChange(row.changeMinor)} $`, tone: row.changeMinor > 0 ? ("bad" as const) : ("ok" as const) },
                }))}
                tone="debt"
                onOpen={open}
              />
              {report.top.rows.length > TOP_FOLDED && (
                <button type="button" className="border-t py-2.5 text-left text-[13px] font-semibold text-muted-foreground" data-more-top onClick={() => setAllTop((all) => !all)}>
                  {allTop ? `Свернуть до ${TOP_FOLDED}` : `Показать топ-${report.top.rows.length}`}
                </button>
              )}
            </Block>
            <Block title="Долго не платят" count={report.overdue.rows.length > 0 ? `${report.overdue.rows.length} · ${formatWhole(report.overdue.totalMinor)} $` : ""} none="Никто не задерживает оплату дольше 30 дней." name="overdue" empty={report.overdue.rows.length === 0}>
              <Rows
                rows={report.overdue.rows.slice(0, OVERDUE_SHOWN).map((row) => ({
                  code: row.code,
                  name: row.name,
                  amountMinor: row.debtMinor,
                  daysUnpaid: row.daysUnpaid,
                  sub: { left: `${row.daysUnpaid} дн. без оплаты`, right: row.lastTripDay ? `посл. рейс ${dayNear(row.lastTripDay, report)}` : "рейсов нет", tone: row.gotCargo ? ("bad" as const) : undefined },
                }))}
                tone="charged"
                onOpen={open}
              />
              <More left={report.overdue.rows.length - OVERDUE_SHOWN} />
            </Block>
          </div>
          <Block title="Контроль по месяцам" count={String(report.control.year)} none="" name="control" empty={false}>
            <ControlTable report={report} />
          </Block>

          <div className="mt-1 flex flex-wrap gap-2">
            <Button type="button" className="h-[46px] flex-1" disabled={busy !== null} onClick={() => setBusy("pictures")}>
              {busy === "pictures" ? "Готовим…" : `Скачать ${many} ${many === 5 ? "картинок" : "картинки"}`}
            </Button>
            <Button type="button" variant="outline" className="h-[46px] flex-1" disabled={busy !== null} onClick={() => void sheet()}>
              {busy === "sheet" ? "Готовим…" : "Excel: не платят 7+ дней"}
            </Button>
          </div>
        </div>
      )}

      {/* The pictures, off the screen and only while they are being made: the blocks as the business has always sent them. */}
      {ready && busy === "pictures" && (
        <div aria-hidden="true" data-pictures style={{ position: "fixed", left: -20000, top: 0, width: PICTURE_WIDTH, pointerEvents: "none" }}>
          <style>{BLOCK_CSS}</style>
          {(
            [
              ["movement", <Movement key="movement" report={report} />],
              ["top", <Top key="top" report={report} />],
              ["overdue", <Overdue key="overdue" report={report} />],
              ["control", <Control key="control" report={report} />],
              ...(report.dynamics ? [["dynamics", <Dynamics key="dynamics" report={report} tile={(tile) => <Tile key={tile.label} {...tile} />} notes={<Notes notes={dynamicsNotes(report)} />} />] as const] : []),
            ] as ReadonlyArray<readonly [PictureKey, ReactNode]>
          ).map(([key, content]) => (
            <div
              key={key}
              className="dr-block"
              ref={(node) => {
                pictures.current[key] = node;
              }}
            >
              {content}
            </div>
          ))}
        </div>
      )}

      <Dialog open={card !== null} onOpenChange={(next) => !next && setCard(null)}>
        <DialogContent className="min-[640px]:max-w-2xl">
          {card && (
            <>
              <DialogTitle>
                {card.code} · {card.name}
              </DialogTitle>
              <DialogDescription className="sr-only">Долг клиента сейчас, рейсы и оплаты по месяцам и долг после каждой строки.</DialogDescription>
              <ClientCard key={card.code} client={{ code: card.code, name: card.name, phone: null, daysUnpaid: card.daysUnpaid }} onSessionExpired={onSessionExpired} />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The four numbers of the period: the debt of all then and now, what the trucks added, what was paid. */
function Tiles({ report }: { report: DebtReport }) {
  const change = report.closingMinor - report.openingMinor;
  const moved = Math.round(Math.abs(change) / 100) !== 0;
  const tiles: Array<{ label: string; value: string; tone?: string; sub?: string; subTone?: string }> = [
    { label: `Долг на ${shortDay(report.since)}`, value: formatWhole(report.openingMinor) },
    {
      label: `Долг на ${shortDay(report.day)}`,
      value: formatWhole(report.closingMinor),
      sub: moved ? `${change > 0 ? "вырос на" : "снизился на"} ${formatWhole(Math.abs(change))} $` : "без изменений",
      subTone: moved ? (change > 0 ? "text-destructive" : "text-success") : undefined,
    },
    {
      label: "Начислено",
      value: `${report.chargedMinor > 0 ? "+" : ""}${formatWhole(report.chargedMinor)}`,
      tone: report.chargedMinor > 0 ? "text-destructive" : "text-muted-foreground",
      sub: report.trips.length > 0 ? chargedCaption(report) : "рейсов не было",
    },
    {
      label: "Оплачено",
      value: `${report.paidMinor > 0 ? "−" : ""}${formatWhole(report.paidMinor)}`,
      tone: report.paidMinor > 0 ? "text-success" : "text-muted-foreground",
      sub: report.payers.length > 0 ? `${report.payers.length} ${plural(report.payers.length, "плательщик", "плательщика", "плательщиков")}` : "оплат не было",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 min-[880px]:grid-cols-4" data-tiles>
      {tiles.map((tile) => (
        <div key={tile.label} className="glass-card grid content-start gap-1 rounded-[22px] px-4 py-3.5" data-tile>
          <div className="text-[12.5px] font-medium text-muted-foreground">{tile.label}</div>
          <div className={cn("text-[22px] leading-tight font-extrabold tracking-tight whitespace-nowrap tabular-nums", tile.tone)}>
            {tile.value}
            <span className="ml-[.3em] text-[.6em] font-semibold">$</span>
          </div>
          {tile.sub && <div className={cn("text-[12.5px] leading-snug text-muted-foreground", tile.subTone)}>{tile.sub}</div>}
        </div>
      ))}
    </div>
  );
}

/** A card of the report: its name, a number beside it, and its lines (or a word when there are none). */
function Block({ title, count, none, name, empty, children }: { title: string; count: string; none: string; name: string; empty: boolean; children: ReactNode }) {
  return (
    <section className="glass-card flex min-w-0 flex-col rounded-[26px] px-4 pt-3.5 pb-2" data-block={name} aria-label={title}>
      <h3 className="mb-1 flex items-baseline justify-between gap-2 text-base font-bold">
        {title}
        <small className="text-[12.5px] font-medium whitespace-nowrap text-muted-foreground">{count}</small>
      </h3>
      {empty ? <div className="pt-2.5 pb-3 text-[13.5px] text-muted-foreground">{none}</div> : children}
    </section>
  );
}

type Row = {
  code: string;
  name: string;
  amountMinor: number;
  place?: number;
  tags?: string[];
  daysUnpaid?: number;
  sub?: { left: string; right: string; tone?: "ok" | "bad" };
};

/** The lines of a card: a client, a sum, and a bar as long as the sum is to the biggest. A tap opens the card of the client. */
function Rows({ rows, tone, onOpen }: { rows: readonly Row[]; tone: "paid" | "charged" | "debt"; onOpen: (client: { code: string; name: string; daysUnpaid?: number }) => void }) {
  const most = rows.reduce((max, row) => Math.max(max, row.amountMinor), 0);
  return (
    <>
      {rows.map((row) => (
        <button
          key={row.code}
          type="button"
          className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-[5px] py-[9px] text-left [&+button]:border-t"
          data-code={row.code}
          aria-label={`Карточка: ${row.code} ${row.name}`}
          onClick={() => onOpen({ code: row.code, name: row.name, daysUnpaid: row.daysUnpaid })}
        >
          <span className="flex min-w-0 items-baseline gap-[5px] text-[14.5px] font-semibold">
            {row.place !== undefined && <i className="flex-none text-[12.5px] font-medium text-muted-foreground not-italic">{row.place}</i>}
            <span className="truncate">{row.name}</span>
            <i className="flex-none text-[12.5px] font-medium text-muted-foreground not-italic">{row.code}</i>
            {row.tags?.map((tag) => (
              <span key={tag} className="flex-none rounded-md bg-accent px-1.5 text-[11px] font-semibold text-muted-foreground">
                {tag}
              </span>
            ))}
          </span>
          <span className="text-[14.5px] font-bold whitespace-nowrap tabular-nums">{formatWhole(row.amountMinor)}</span>
          <span className="col-span-full h-1.5 overflow-hidden rounded-[3px] bg-muted">
            <i className={cn("block h-full min-w-[3px] rounded-[3px]", tone === "paid" ? "bg-success" : tone === "charged" ? "bg-destructive" : "bg-muted-foreground")} style={{ width: `${most > 0 ? Math.max(2, (row.amountMinor / most) * 100) : 0}%` }} />
          </span>
          {row.sub && (
            <span className="col-span-full flex justify-between gap-2 text-[12px] text-muted-foreground">
              <span>{row.sub.left}</span>
              <span className={cn(row.sub.tone === "bad" && "text-destructive", row.sub.tone === "ok" && "text-success")}>{row.sub.right}</span>
            </span>
          )}
        </button>
      ))}
    </>
  );
}

/** «и ещё 11»: how many lines of a card are not shown. */
function More({ left }: { left: number }) {
  return left > 0 ? <div className="border-t py-2.5 text-[13px] font-semibold text-muted-foreground">и ещё {left}</div> : null;
}

/** The control sheet of the year on the screen: month by month, up to the day of the report. */
function ControlTable({ report }: { report: DebtReport }) {
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px] tabular-nums">
          <thead>
            <tr className="border-b text-left text-[12px] text-muted-foreground [&_th]:px-1.5 [&_th]:py-2 [&_th]:font-semibold">
              <th>Месяц</th>
              <th className="text-right">Остаток нач.</th>
              <th className="text-right">Начислено</th>
              <th className="text-right">Оплачено</th>
              <th className="text-right">Остаток кон.</th>
            </tr>
          </thead>
          <tbody className="[&_td]:px-1.5 [&_td]:py-1.5 [&_td]:whitespace-nowrap">
            {report.control.months.map((month) => (
              <tr key={month.month} data-month={month.month} className="border-b last:border-b-0">
                <td>{monthName(month.month)}</td>
                <td className="text-right">{formatCents(month.openingMinor)}</td>
                <td className="text-right">{formatCents(month.chargedMinor)}</td>
                <td className="text-right">{formatCents(month.paidMinor)}</td>
                <td className="text-right font-semibold">{formatCents(month.closingMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {controlNotes(report).map((note) => (
        <p key={note} className="py-2 text-[12px] text-muted-foreground" data-control-note>
          {note}
        </p>
      ))}
    </>
  );
}

function Notes({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null;
  return (
    <p className="dr-note" data-note>
      {notes.join(" ")}
    </p>
  );
}

function Tile({ label, value, sub, tone, framed, subTone }: { label: string; value: string; sub?: string; tone?: "ok" | "bad" | "muted"; framed?: boolean; subTone?: "ok" | "bad" }) {
  return (
    <div className={cn("dr-tile", framed && "dr-framed")} data-tile>
      <div className="dr-tile-label">{label}</div>
      <div className={cn("dr-tile-value", tone && `dr-${tone}`)}>{value}</div>
      {sub && <div className={cn("dr-tile-sub", subTone && `dr-${subTone}`)}>{sub}</div>}
    </div>
  );
}

/** A client in a list: the name gives way when there is no room, the code never does. */
function Client({ name, code }: { name: string; code: string }) {
  return (
    <>
      <b>{name}</b>
      <span className="dr-code">({code})</span>
    </>
  );
}

type BarRow = { code: string; name: string; amountMinor: number; tags: string[] };

/** A list of bars: the biggest eight, each as long as its share of the first. */
function Bars({ title, rows, tone, rest }: { title: string; rows: readonly BarRow[]; tone: "paid" | "charged"; rest: string | null }) {
  const most = rows[0]?.amountMinor ?? 0;
  return (
    <div className="dr-list" data-list={tone}>
      <div className="dr-list-title">{title}</div>
      {rows.slice(0, BARS_SHOWN).map((row) => (
        <div key={row.code} className="dr-bar-row" data-code={row.code}>
          <div className="dr-bar-name">
            <Client name={row.name} code={row.code} />
            {row.tags.map((tag) => (
              <span key={tag} className="dr-tag">
                {tag}
              </span>
            ))}
          </div>
          <div>
            <div className={`dr-bar dr-${tone}`} style={{ width: `${most > 0 ? Math.max(1, (row.amountMinor / most) * 100) : 0}%` }} />
          </div>
          <div className="dr-bar-sum">{formatWhole(row.amountMinor)}</div>
        </div>
      ))}
      {rest && <div className="dr-rest">{rest}</div>}
    </div>
  );
}

/** The first picture: the debt of all then and now, what was charged and paid in between, who paid and who was charged. */
function Movement({ report }: { report: DebtReport }) {
  const { labelOf } = useKassa();
  const change = report.closingMinor - report.openingMinor;
  const moved = Math.round(Math.abs(change) / 100) !== 0;
  const period = periodLabel(report);
  const payers: BarRow[] = report.payers.map((payer) => ({ code: payer.code, name: payer.name, amountMinor: payer.amountMinor, tags: payer.kassas.map((kassa) => labelOf(kassa)) }));
  const charged: BarRow[] = report.charged.map((client) => ({ code: client.code, name: client.name, amountMinor: client.amountMinor, tags: [client.trips.join(", ")] }));
  return (
    <>
      <div className="dr-tiles">
        <Tile label={`Долг на ${shortDay(report.since)}`} value={`$${formatWhole(report.openingMinor)}`} />
        <Tile label="Начислено" value={report.chargedMinor > 0 ? `+ ${formatWhole(report.chargedMinor)}` : "0"} tone={report.chargedMinor > 0 ? "bad" : "muted"} sub={chargedCaption(report)} />
        <Tile label="Оплачено" value={report.paidMinor !== 0 ? `− ${formatWhole(report.paidMinor)}` : "0"} tone={report.paidMinor > 0 ? "ok" : "muted"} sub={paidCaption(report, labelOf)} />
        <Tile label={`Долг на ${shortDay(report.day)}`} value={`$${formatWhole(report.closingMinor)}`} framed sub={changeCaption(report)} subTone={moved ? (change < 0 ? "ok" : "bad") : undefined} />
      </div>
      {(payers.length > 0 || charged.length > 0) && (
        <div className={cn("dr-cols", payers.length > 0 && charged.length > 0 && "dr-two")}>
          {payers.length > 0 && <Bars title={`Кто оплатил ${period}`} rows={payers} tone="paid" rest={restLine(report.payers, ["плательщик", "плательщика", "плательщиков"])} />}
          {charged.length > 0 && <Bars title={`Кому начислено ${period}`} rows={charged} tone="charged" rest={restLine(report.charged, ["клиент", "клиента", "клиентов"])} />}
        </div>
      )}
      <Notes notes={movementNotes(report)} />
    </>
  );
}

/** The second picture: the thirty who owe most. */
function Top({ report }: { report: DebtReport }) {
  const { rows } = report.top;
  const most = rows[0]?.debtMinor ?? 0;
  if (rows.length === 0) return <div className="dr-empty">На {shortDay(report.day)} должников нет.</div>;
  return (
    <>
      <div className="dr-scroll">
      <table className="dr-table dr-top">
        <thead>
          <tr>
            <th className="dr-place">#</th>
            <th>Клиент</th>
            <th className="dr-barcell" />
            <th className="dr-num">Долг, $</th>
            <th className="dr-num">{periodDays(report) <= 1 ? `За ${shortDay(report.day)}` : `С ${shortDay(report.since)}`}</th>
            <th className="dr-num">Посл. оплата</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.code} data-code={row.code}>
              <td className="dr-place">{row.place}</td>
              <td>
                <div className="dr-client">
                  <Client name={row.name} code={row.code} />
                  {row.isNew && <span className="dr-tag">новый</span>}
                </div>
              </td>
              <td className="dr-barcell">
                <div className="dr-bar dr-debt" style={{ width: `${most > 0 ? Math.max(1, (row.debtMinor / most) * 100) : 0}%` }} />
              </td>
              <td className="dr-num">{formatWhole(row.debtMinor)}</td>
              <td className={cn("dr-num", Math.round(Math.abs(row.changeMinor) / 100) === 0 ? "dr-muted" : row.changeMinor > 0 ? "dr-bad" : "dr-ok")}>{formatChange(row.changeMinor)}</td>
              <td className={cn("dr-num", row.lastPaidDay !== null && row.daysUnpaid >= 30 ? "dr-bad" : "dr-muted")} data-last-paid>
                {row.lastPaidDay ? dayNear(row.lastPaidDay, report) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <Notes notes={topNotes(report)} />
    </>
  );
}

/** The third picture: who owes over 500 $ and has not paid for thirty days and more. */
function Overdue({ report }: { report: DebtReport }) {
  const { overdue } = report;
  return (
    <>
      <div className="dr-tiles dr-three">
        <Tile label="Не платят 30+ дней" value={clientsCount(overdue.rows.length)} />
        <Tile label="Их долг" value={`$${formatWhole(overdue.totalMinor)}`} />
        <Tile label={`Из них 90+ дней или ни разу${report.historyFrom.slice(0, 4) === report.day.slice(0, 4) ? ` в ${report.day.slice(0, 4)}` : ""}`} value={clientsCount(overdue.long)} />
      </div>
      {overdue.rows.length > 0 && (
        <div className="dr-scroll">
        <table className="dr-table dr-overdue" style={{ marginTop: 14 }}>
          <thead>
            <tr>
              <th>Клиент</th>
              <th className="dr-num">Долг, $</th>
              <th className="dr-num">Посл. оплата</th>
              <th className="dr-num">Без оплаты</th>
              <th className="dr-num">Посл. рейс</th>
            </tr>
          </thead>
          <tbody>
            {overdue.rows.map((row) => (
              <tr key={row.code} data-code={row.code}>
                <td>
                  <div className="dr-client">
                    <Client name={row.name} code={row.code} />
                    {row.isNew && <span className="dr-tag">новый</span>}
                  </div>
                </td>
                <td className="dr-num">{formatWhole(row.debtMinor)}</td>
                <td className={cn("dr-num", row.lastPaidDay === null && "dr-muted")}>{row.lastPaidDay ? yearDay(row.lastPaidDay) : neverPaid(report)}</td>
                <td className="dr-num">
                  <span className={cn("dr-plate", row.daysUnpaid >= 90 && "dr-long")}>{row.daysUnpaid} дн.</span>
                </td>
                <td className={cn("dr-num", row.gotCargo && "dr-bad", row.lastTripDay === null && "dr-muted")} data-last-trip>
                  {row.lastTripDay ? yearDay(row.lastTripDay) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
      <Notes notes={overdueNotes(report)} />
    </>
  );
}

/** The fourth picture: the control sheet of the year, month by month, up to the day. */
function Control({ report }: { report: DebtReport }) {
  return (
    <>
      <div className="dr-scroll">
      <table className="dr-table dr-control">
        <thead>
          <tr>
            <th>Месяц</th>
            <th className="dr-num">Остаток нач.</th>
            <th className="dr-num">Начислено</th>
            <th className="dr-num">Оплачено</th>
            <th className="dr-num">Остаток кон.</th>
          </tr>
        </thead>
        <tbody>
          {report.control.months.map((month) => (
            <tr key={month.month} data-month={month.month}>
              <td>{monthName(month.month)}</td>
              <td className="dr-num">{formatCents(month.openingMinor)}</td>
              <td className="dr-num">{formatCents(month.chargedMinor)}</td>
              <td className="dr-num">{formatCents(month.paidMinor)}</td>
              <td className="dr-num">{formatCents(month.closingMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <Notes notes={controlNotes(report)} />
    </>
  );
}
