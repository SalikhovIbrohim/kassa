import type { DebtReport } from "./api";
import { axisLabel, axisTicks, formatChange, formatWhole, monthName, shortDay, shortMonth } from "./debt-report";

/** The size of a chart, in the pixels of a picture: as wide as a block is inside its margins. */
const WIDTH = 728;

type Tile = { label: string; value: string; sub?: string; tone?: "ok" | "bad" | "muted"; subTone?: "ok" | "bad"; framed?: boolean };

/**
 * The fifth picture, drawn only on the last day of a month: the month looked back on. What all the clients owed day
 * by day, and the year month by month: what the trucks added and what was paid, with what was owed at the end of
 * each month under its name.
 */
export function Dynamics({ report, tile, notes }: { report: DebtReport; tile: (tile: Tile) => React.ReactNode; notes: React.ReactNode }) {
  const dynamics = report.dynamics!;
  const month = report.control.months[report.control.months.length - 1];
  const closing = dynamics.days[dynamics.days.length - 1]?.closingMinor ?? dynamics.openingMinor;
  const change = closing - dynamics.openingMinor;
  const moved = Math.round(Math.abs(change) / 100) !== 0;
  const before = new Date(Date.parse(`${dynamics.month}-01T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const name = monthName(dynamics.month).toLowerCase();
  return (
    <>
      <div className="dr-tiles">
        {tile({ label: `Долг на ${shortDay(before)}`, value: `$${formatWhole(dynamics.openingMinor)}` })}
        {tile({ label: `Начислено за ${name}`, value: month && month.chargedMinor > 0 ? `+ ${formatWhole(month.chargedMinor)}` : "0", tone: month && month.chargedMinor > 0 ? "bad" : "muted" })}
        {tile({ label: `Оплачено за ${name}`, value: month && month.paidMinor !== 0 ? `− ${formatWhole(month.paidMinor)}` : "0", tone: month && month.paidMinor > 0 ? "ok" : "muted" })}
        {tile({ label: `Долг на ${shortDay(report.day)}`, value: `$${formatWhole(closing)}`, framed: true, sub: moved ? `${formatChange(change)} за месяц` : "без изменений за месяц", subTone: moved ? (change < 0 ? "ok" : "bad") : undefined })}
      </div>
      <div className="dr-chart-title">Долг по дням, {name}</div>
      <div className="dr-scroll">
        <DebtByDay report={report} />
      </div>
      <div className="dr-chart-title dr-with-legend">
        <span>Начислено и оплачено по месяцам, {report.control.year}</span>
        <span className="dr-legend">
          <i className="dr-swatch dr-charged" />
          Начислено
          <i className="dr-swatch dr-paid" />
          Оплачено
        </span>
      </div>
      <div className="dr-scroll">
        <ByMonth report={report} />
      </div>
      {notes}
    </>
  );
}

/** What all the clients owed at the end of each day of the month: one line, its end, its top and its bottom named. */
function DebtByDay({ report }: { report: DebtReport }) {
  const { days } = report.dynamics!;
  const height = 230;
  const left = 58;
  const right = 72;
  const top = 22;
  const bottom = 24;
  const values = days.map((day) => day.closingMinor / 100);
  const ticks = axisTicks(Math.min(...values), Math.max(...values), 4);
  const low = ticks[0]!;
  const high = ticks[ticks.length - 1]!;
  const plotWidth = WIDTH - left - right;
  const plotHeight = height - top - bottom;
  const x = (index: number) => left + (days.length > 1 ? (index / (days.length - 1)) * plotWidth : plotWidth / 2);
  const y = (value: number) => top + (1 - (value - low) / (high - low)) * plotHeight;
  const points = values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`);
  const last = days.length - 1;
  const most = values.indexOf(Math.max(...values));
  const least = values.indexOf(Math.min(...values));
  // The top and the bottom are named where their names do not run into the name of the end.
  const named = [most, least].filter((index, place, all) => index !== last && all.indexOf(index) === place && x(last) - x(index) > 64);
  // The days named under the axis: the first, every fifth, the last.
  const marked = days.map((_, index) => index).filter((index) => index === 0 || index === last || ((index + 1) % 5 === 0 && last - index >= 3));
  const step = days.length > 1 ? plotWidth / (days.length - 1) : plotWidth;
  return (
    <svg className="dr-chart" viewBox={`0 0 ${WIDTH} ${height}`} width="100%" role="img" aria-label="Долг всех клиентов по дням месяца" data-chart="days">
      {ticks.map((tick) => (
        <g key={tick}>
          <line className="dr-grid" x1={left} x2={WIDTH - right} y1={y(tick)} y2={y(tick)} />
          <text className="dr-axis" x={left - 8} y={y(tick) + 4} textAnchor="end">
            {axisLabel(tick, ticks)}
          </text>
        </g>
      ))}
      {marked.map((index) => (
        <text key={index} className="dr-axis" x={x(index)} y={height - 6} textAnchor="middle">
          {Number(days[index]!.day.slice(8, 10))}
        </text>
      ))}
      <polyline className="dr-line" points={points.join(" ")} />
      {named.map((index) => (
        <g key={index}>
          <circle className="dr-dot" cx={x(index)} cy={y(values[index]!)} r={4} />
          <text className="dr-value" x={Math.max(left + 22, x(index))} y={index === most ? y(values[index]!) - 9 : y(values[index]!) + 18} textAnchor="middle">
            {formatWhole(days[index]!.closingMinor)}
          </text>
        </g>
      ))}
      <circle className="dr-dot" cx={x(last)} cy={y(values[last]!)} r={4} />
      <text className="dr-value" x={x(last) + 9} y={y(values[last]!) + 4}>
        {formatWhole(days[last]!.closingMinor)}
      </text>
      {/* What the pointer reads: a day and its debt. */}
      {days.map((day, index) => (
        <rect key={day.day} className="dr-hit" x={x(index) - step / 2} y={top} width={step} height={plotHeight}>
          <title>{`${shortDay(day.day)}: долг ${formatWhole(day.closingMinor)}${day.chargedMinor ? `, начислено ${formatWhole(day.chargedMinor)}` : ""}${day.paidMinor ? `, оплачено ${formatWhole(day.paidMinor)}` : ""}`}</title>
        </rect>
      ))}
    </svg>
  );
}

/** A column that stands on the baseline, its top rounded. */
function column(x: number, y: number, width: number, height: number): string {
  const radius = Math.min(4, width / 2, height);
  return `M${x},${y + height} L${x},${y + radius} Q${x},${y} ${x + radius},${y} L${x + width - radius},${y} Q${x + width},${y} ${x + width},${y + radius} L${x + width},${y + height} Z`;
}

/** The months of the year side by side: what the trucks added and what was paid, and under each month what was owed at its end. */
function ByMonth({ report }: { report: DebtReport }) {
  const { months } = report.control;
  const height = 214;
  const left = 58;
  const right = 6;
  const top = 12;
  const bottom = 44;
  const ticks = axisTicks(0, Math.max(1, ...months.map((month) => Math.max(month.chargedMinor, month.paidMinor) / 100)), 4);
  const high = ticks[ticks.length - 1]!;
  const plotWidth = WIDTH - left - right;
  const plotHeight = height - top - bottom;
  // Always the twelve places of a year, so that a month stands where it does in every picture of the year.
  const band = plotWidth / 12;
  const bar = Math.min(16, (band - 14) / 2);
  const gap = 2;
  const y = (value: number) => top + (1 - value / high) * plotHeight;
  const base = top + plotHeight;
  return (
    <svg className="dr-chart" viewBox={`0 0 ${WIDTH} ${height}`} width="100%" role="img" aria-label="Начислено и оплачено по месяцам" data-chart="months">
      {ticks.map((tick) => (
        <g key={tick}>
          <line className="dr-grid" x1={left} x2={WIDTH - right} y1={y(tick)} y2={y(tick)} />
          <text className="dr-axis" x={left - 8} y={y(tick) + 4} textAnchor="end">
            {axisLabel(tick, ticks)}
          </text>
        </g>
      ))}
      {months.map((month) => {
        const middle = left + (Number(month.month.slice(5, 7)) - 0.5) * band;
        const charged = Math.max(0, month.chargedMinor / 100);
        const paid = Math.max(0, month.paidMinor / 100);
        return (
          <g key={month.month} data-month={month.month}>
            {charged > 0 && <path className="dr-col dr-charged" d={column(middle - gap / 2 - bar, y(charged), bar, base - y(charged))} />}
            {paid > 0 && <path className="dr-col dr-paid" d={column(middle + gap / 2, y(paid), bar, base - y(paid))} />}
            <text className="dr-axis" x={middle} y={base + 16} textAnchor="middle">
              {shortMonth(month.month)}
            </text>
            <text className="dr-under" x={middle} y={base + 33} textAnchor="middle">
              {formatWhole(month.closingMinor / 1000)}
            </text>
            <rect className="dr-hit" x={middle - band / 2} y={top} width={band} height={plotHeight + bottom}>
              <title>{`${monthName(month.month)}: начислено ${formatWhole(month.chargedMinor)}, оплачено ${formatWhole(month.paidMinor)}, остаток на конец ${formatWhole(month.closingMinor)}`}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}
