import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { fetchDebtReport, fetchUnpaidSheet, SessionExpiredError, type DebtReport } from "./api";
import { cashDayToday, formatDay, shiftDay } from "./days";
import {
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
import { BLOCK_CSS, canCopyPictures, copyPicture, givePictures, NARROW_CSS, pictureOf, saveFile } from "./report-picture";
import { Button } from "@/components/ui/button";
import { alertVariants } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

type Props = {
  onSessionExpired: () => void;
  /** The screen is on show: a hidden one asks for nothing, and asks again when it comes back. */
  active?: boolean;
};

/** The longest period a report covers, as the server has it. */
const MAX_PERIOD_DAYS = 92;

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
 * «Отчёты»: the debts of the clients for a day of the cash desk, in the four pictures the business sends on every
 * evening. Each is drawn here from what the server worked out, and each can be saved as a PNG.
 */
export function DebtReports({ onSessionExpired, active = true }: Props) {
  // Worked out again on every render: a page left open overnight must still know what day it is.
  const today = cashDayToday();
  const [day, setDay] = useState(today);
  // The day compared with; null is the day before.
  const [since, setSince] = useState<string | null>(null);
  // null: loading; undefined: failed.
  const [report, setReport] = useState<DebtReport | null | undefined>(null);
  const [stale, setStale] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const blocks = useRef<Record<PictureKey, HTMLDivElement | null>>({ movement: null, top: null, overdue: null, control: null, dynamics: null });

  const before = shiftDay(day, -1);
  const asked = since !== null && since < day ? since : before;

  useEffect(() => {
    if (!active) return;
    let current = true;
    setStale(true);
    fetchDebtReport(day, asked).then(
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
  }, [active, day, asked, reloads, onSessionExpired]);

  const choose = (next: string) => {
    if (!next || next > today) return;
    setDay(next);
    setSince(null);
  };

  const name = (file: string) => `dolgi-${day}-${file}.png`;
  /** Does something that takes a moment, one thing at a time, and says so when it fails. */
  const work = useCallback(
    async (what: string, task: () => Promise<void>) => {
      setBusy(what);
      try {
        await task();
      } catch (caught) {
        if (caught instanceof SessionExpiredError) onSessionExpired();
        else toast("Не получилось. Попробуйте ещё раз.");
      } finally {
        setBusy(null);
      }
    },
    [onSessionExpired],
  );
  const save = (key: PictureKey, file: string) =>
    work(key, async () => {
      const block = blocks.current[key];
      if (block) await givePictures([{ blob: await pictureOf(block), name: name(file) }]);
    });
  const copy = (key: PictureKey) =>
    work(`copy-${key}`, async () => {
      const block = blocks.current[key];
      if (!block) return;
      await copyPicture(await pictureOf(block));
      toast("Картинка скопирована");
    });
  const saveAll = () =>
    work("all", async () => {
      const pictures: Array<{ blob: Blob; name: string }> = [];
      for (const picture of PICTURES) {
        const block = blocks.current[picture.key];
        if (block) pictures.push({ blob: await pictureOf(block), name: name(picture.file) });
      }
      await givePictures(pictures);
    });
  const sheet = () => work("sheet", async () => saveFile(await fetchUnpaidSheet(day), `ne-platyat-7-dney-${day}.xlsx`));

  const ready = report !== null && report !== undefined;
  // On a phone the button that saves hands the picture to a chat by itself: one button is enough there.
  const copies = canCopyPictures() && !matchMedia("(pointer: coarse)").matches;
  const picture = (key: PictureKey, title: string, file: string, content: ReactNode) => (
    <section key={key} className="grid min-w-0 gap-2" data-picture={key} aria-label={title}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex-1 text-[17px] font-bold">{title}</h3>
        {copies && (
          <Button type="button" variant="outline" size="sm" className="h-9 px-3" disabled={busy !== null} onClick={() => void copy(key)}>
            Копировать
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" className="h-9 px-3" disabled={busy !== null} onClick={() => void save(key, file)}>
          {busy === key ? "Готовим…" : "Скачать PNG"}
        </Button>
      </div>
      <div className="dr-wrap overflow-hidden rounded-[14px]">
        <div
          className="dr-block"
          ref={(node) => {
            blocks.current[key] = node;
          }}
        >
          {content}
        </div>
      </div>
    </section>
  );

  return (
    <div className="mx-auto grid w-full max-w-[760px] min-w-0 gap-4" data-debt-report aria-busy={stale}>
      <style>{BLOCK_CSS + NARROW_CSS}</style>
      <div className="glass-card grid gap-3 rounded-lg px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1">
            <Label htmlFor="report-day">День</Label>
            <div className="flex items-center gap-1.5">
              <Button type="button" variant="outline" size="sm" className="h-10 px-3" aria-label="Предыдущий день" onClick={() => choose(shiftDay(day, -1))}>
                ‹
              </Button>
              <Input id="report-day" type="date" name="day" className="w-[10.5rem]" value={day} max={today} onChange={(event) => choose(event.target.value)} />
              <Button type="button" variant="outline" size="sm" className="h-10 px-3" aria-label="Следующий день" disabled={day >= today} onClick={() => choose(shiftDay(day, 1))}>
                ›
              </Button>
            </div>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="report-since">Сравнить с днём</Label>
            <Input
              id="report-since"
              type="date"
              name="since"
              className="w-[10.5rem]"
              value={asked}
              min={shiftDay(day, -MAX_PERIOD_DAYS)}
              max={before}
              onChange={(event) => {
                const next = event.target.value;
                if (next && next < day && next >= shiftDay(day, -MAX_PERIOD_DAYS)) setSince(next === before ? null : next);
              }}
            />
          </div>
          <Button type="button" variant="outline" size="sm" className="h-10" onClick={() => setReloads((count) => count + 1)}>
            Обновить
          </Button>
        </div>
        <p className="text-[13px] leading-snug text-muted-foreground">
          Долги клиентов на конец дня {formatDay(day)} и что изменилось после {formatDay(asked)}. День кассы закрывается сам в 03:00 по Москве; обычно сравнивают со вчерашним, после
          выходных — с последним рабочим днём.
        </p>
        {ready && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy !== null} onClick={() => void saveAll()}>
              {busy === "all" ? "Готовим…" : report.dynamics ? "Скачать все 5 картинок" : "Скачать все 4 картинки"}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void sheet()}>
              {busy === "sheet" ? "Готовим…" : "Excel: не платят больше 7 дней"}
            </Button>
          </div>
        )}
      </div>

      {report === null && <p className="hint">Загружаем…</p>}
      {report === undefined && (
        <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
          Не удалось загрузить отчёт. Проверьте связь и нажмите «Обновить».
        </p>
      )}
      {ready && (
        <div className={cn("grid min-w-0 gap-6 transition-opacity", stale && "opacity-60")}>
          {picture("movement", periodDays(report) <= 1 ? "Изменение долга за день" : "Изменение долга за период", PICTURES[0].file, <Movement report={report} />)}
          {picture("top", report.debtors.count > report.top.rows.length ? PICTURES[1].title : "Должники", PICTURES[1].file, <Top report={report} />)}
          {picture("overdue", PICTURES[2].title, PICTURES[2].file, <Overdue report={report} />)}
          {picture("control", PICTURES[3].title, PICTURES[3].file, <Control report={report} />)}
          {report.dynamics &&
            picture(
              "dynamics",
              `Динамика за ${monthName(report.dynamics.month).toLowerCase()}`,
              PICTURES[4].file,
              <Dynamics report={report} tile={(tile) => <Tile key={tile.label} {...tile} />} notes={<Notes notes={dynamicsNotes(report)} />} />,
            )}
        </div>
      )}
    </div>
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
