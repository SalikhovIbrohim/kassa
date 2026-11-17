import { describe, expect, it } from "vitest";
import type { DebtReport } from "./api";
import {
  axisLabel,
  axisTicks,
  backdatedNote,
  changeCaption,
  chargedCaption,
  controlNotes,
  deskOf,
  dynamicsNotes,
  formatCents,
  formatChange,
  formatWhole,
  movementNotes,
  neverPaid,
  overdueNotes,
  paidCaption,
  periodLabel,
  restLine,
  topNotes,
  who,
} from "./debt-report";

/** Non-breaking spaces are what the report puts between thousands and inside a name; the tests read them as plain ones. */
const plain = (text: string) => text.replace(/[  ]/g, " ");
const plainAll = (texts: readonly string[]) => texts.map(plain);

const LABELS: Record<string, string> = { moscow: "Москва", tashkent: "Ташкент", andijan: "Андижан", fergana: "Фергана" };
const labelOf = (kassa: string) => LABELS[kassa] ?? kassa;

/** A quiet day: nothing came, nobody paid, nothing changed. What a test is about is put on top of it. */
function quiet(more: Partial<DebtReport> = {}): DebtReport {
  return {
    day: "2026-11-16",
    since: "2026-11-15",
    historyFrom: "2026-01-01",
    primaryKassa: "moscow",
    openingMinor: 73_340_659,
    closingMinor: 73_340_659,
    chargedMinor: 0,
    paidMinor: 0,
    trips: [],
    chargedClients: 0,
    paidElsewhere: [],
    days: [],
    payers: [],
    refunds: [],
    charged: [],
    events: { closed: [], paidTrip: [], firstPayment: [], crossed: null },
    backdated: null,
    debtors: { count: 0, totalMinor: 0 },
    top: { rows: [], totalMinor: 0, left: [], entered: [], moved: [], near: [], crossed: [] },
    overdue: { rows: [], totalMinor: 0, long: 0, left: [], came: [] },
    control: { year: 2026, months: [], agrees: true },
    dynamics: null,
    ...more,
  };
}

const payer = (code: string, name: string, amountMinor: number, more: Partial<DebtReport["payers"][number]> = {}) => ({ code, name, amountMinor, kassas: [], debtMinor: 100_000, closed: false, ...more });

describe("the numbers of the report", () => {
  it("writes whole dollars with the thousands apart, and a change with its sign", () => {
    expect(plain(formatWhole(2_857_411))).toBe("28 574");
    expect(plain(formatWhole(73_340_659))).toBe("733 407");
    expect(formatWhole(49)).toBe("0");
    expect(formatWhole(-43)).toBe("0");
    expect(plain(formatWhole(-1_250_000))).toBe("−12 500");
    expect(plain(formatChange(266_100))).toBe("+2 661");
    expect(plain(formatChange(-300_000))).toBe("−3 000");
    expect(formatChange(0)).toBe("—");
    // Less than half a dollar is no change worth a number.
    expect(formatChange(-43)).toBe("—");
  });

  it("writes cents the way the control sheet has them", () => {
    expect(plain(formatCents(73_004_700))).toBe("730 047,00");
    expect(plain(formatCents(70_677_359))).toBe("706 773,59");
    expect(formatCents(5)).toBe("0,05");
    expect(plain(formatCents(-123_456))).toBe("−1 234,56");
  });

  it("names a client with the code, and a period by its days", () => {
    expect(plain(who({ code: "200", name: "Шухрад" }))).toBe("Шухрад (200)");
    expect(periodLabel({ day: "2026-11-16", since: "2026-11-15" })).toBe("16.11");
    expect(periodLabel({ day: "2026-11-16", since: "2026-11-13" })).toBe("14–16.11");
    expect(periodLabel({ day: "2026-11-02", since: "2026-10-29" })).toBe("30.10–02.11");
  });
});

describe("what stands under the tiles", () => {
  it("says what the debt did over the day or the days", () => {
    expect(plain(changeCaption(quiet({ openingMinor: 73_114_000, closingMinor: 71_132_300 })))).toBe("−19 817 за день");
    expect(plain(changeCaption(quiet({ openingMinor: 71_132_300, closingMinor: 72_690_800 })))).toBe("+15 585 за день");
    expect(plain(changeCaption(quiet({ since: "2026-11-14", openingMinor: 100, closingMinor: 500_100 })))).toBe("+5 000 за 2 дня");
    expect(plain(changeCaption(quiet({ since: "2026-11-11", openingMinor: 100, closingMinor: 500_100 })))).toBe("+5 000 за 5 дней");
    expect(changeCaption(quiet())).toBe("без изменений за день");
  });

  it("names the trucks that came and how many clients they were charged to", () => {
    expect(chargedCaption(quiet())).toBe("рейсов не было");
    const truck = (number: number, day: string) => ({ number, day, amountMinor: 3_130_465, clients: 19 });
    expect(plain(chargedCaption(quiet({ trips: [truck(241, "2026-11-05")], chargedClients: 19 })))).toBe("рейс 241 (05.11), 19 клиентов");
    expect(plain(chargedCaption(quiet({ trips: [truck(242, "2026-11-07"), truck(243, "2026-11-07")], chargedClients: 31 })))).toBe("рейсы 242, 243 (07.11), 31 клиент");
    expect(plain(chargedCaption(quiet({ trips: [truck(244, "2026-11-09"), truck(245, "2026-11-14")], chargedClients: 42 })))).toBe("рейсы 244 (09.11), 245 (14.11); 42 клиента");
  });

  it("says how many paid and which desks took it", () => {
    expect(paidCaption(quiet(), labelOf)).toBe("оплат не было");
    const ten = Array.from({ length: 10 }, (_, index) => payer(String(index + 1), "Клиент", 100_000));
    expect(plain(paidCaption(quiet({ payers: ten, paidMinor: 1_000_000 }), labelOf))).toBe("10 клиентов, все — касса Москвы");
    expect(plain(paidCaption(quiet({ payers: ten.slice(0, 2), paidMinor: 200_000, paidElsewhere: [{ kassa: "tashkent", amountMinor: 600_000 }, { kassa: "andijan", amountMinor: 50_000 }] }), labelOf))).toBe(
      "2 клиента, из них Ташкент 6 000, Андижан 500",
    );
    // Only money given back: nobody paid.
    expect(paidCaption(quiet({ paidMinor: -5_000, refunds: [{ code: "3", name: "Рахим", amountMinor: 5_000 }] }), labelOf)).toBe("только возвраты клиентам");
    // A desk in a city the words do not know is named as it is.
    expect(deskOf("Москва")).toBe("касса Москвы");
    expect(deskOf("Фергана")).toBe("касса «Фергана»");
  });
});

describe("the line under a list of bars", () => {
  const noun = ["плательщик", "плательщика", "плательщиков"] as const;
  const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ code: String(index + 1), name: "К", amountMinor: (count - index) * 10_000 }));

  it("says that everybody is shown when the list is no longer than eight", () => {
    expect(restLine([], noun)).toBeNull();
    expect(restLine(rows(1), noun)).toBeNull();
    expect(plain(restLine(rows(3), noun)!)).toBe("Все 3 плательщика показаны");
    expect(plain(restLine(rows(8), noun)!)).toBe("Все 8 плательщиков показаны");
  });

  it("names the rest with their sums, and whose debt is closed", () => {
    const list = [...rows(8), { code: "131", name: "Илхом", amountMinor: 40_000 }, { code: "66", name: "Тимур", amountMinor: 24_700, closed: true }];
    expect(plain(restLine(list, noun)!)).toBe("Ещё 2 клиента: 647 (Илхом (131) 400, Тимур (66) 247 — долг закрыт)");
  });

  it("names only the first eight of a long rest, and counts the others", () => {
    const line = plain(restLine(rows(8 + 13), noun)!);
    expect(line.startsWith("Ещё 13 клиентов: 9 100 (К (9) 1 300, К (10) 1 200,")).toBe(true);
    expect(line.endsWith("К (16) 600 и ещё 5 — меньше 600 каждый)")).toBe(true);
  });
});

describe("the notes under the pictures", () => {
  it("say whether anything was written into the closed days, and what", () => {
    expect(backdatedNote(quiet())).toBe("Закрытие 15.11 не сохранено — правки задним числом не проверялись.");
    const kept = { takenAt: "2026-11-16T00:05:00.000Z", thenMinor: 73_340_659, changes: [], trips: [], topIn: [], topOut: [], overdueIn: [], overdueOut: [] };
    expect(backdatedNote(quiet({ backdated: kept }))).toBe("Задним числом до 15.11 ничего не менялось — долг на 15.11 тот же.");
    // A payment entered late for a day before: the debt of that day is another now.
    expect(plain(backdatedNote(quiet({ openingMinor: 71_082_300, backdated: { ...kept, thenMinor: 71_132_300, changes: [{ code: "77", name: "Машкур", changeMinor: -50_000 }] } })))).toBe(
      "Задним числом после закрытия 15.11: изменился долг: Машкур (77) −500. Поэтому долг на 15.11 теперь 710 823, а не 711 323.",
    );
    // A sum moved from one client to another: the debt of all is the same.
    expect(plain(backdatedNote(quiet({ backdated: { ...kept, changes: [{ code: "2", name: "Захар", changeMinor: 30_000 }, { code: "3", name: "Рахим", changeMinor: -30_000 }] } })))).toBe(
      "Задним числом после закрытия 15.11: изменился долг: Захар (2) +300, Рахим (3) −300. Общий долг на 15.11 тот же: сумма перенесена между клиентами.",
    );
    // A truck marked as arrived after the fact, and many clients with it: the first are named, the others counted.
    const many = Array.from({ length: 9 }, (_, index) => ({ code: String(index + 1), name: "К", changeMinor: 100_000 }));
    expect(
      plain(backdatedNote(quiet({ openingMinor: 74_240_659, backdated: { ...kept, changes: many, trips: [{ number: 252, day: "2026-11-14", amountMinor: 900_000, clients: 9 }] } }))),
    ).toBe(
      "Задним числом после закрытия 15.11: рейс 252 (14.11) отмечен прибывшим после закрытия: +9 000, 9 клиентов; изменился долг: К (1) +1 000, К (2) +1 000, К (3) +1 000, К (4) +1 000, К (5) +1 000, К (6) +1 000 и ещё 3. Поэтому долг на 15.11 теперь 742 407, а не 733 407.",
    );
  });

  it("tell a period day by day, and what is worth a word", () => {
    const notes = plainAll(
      movementNotes(
        quiet({
          since: "2026-11-04",
          day: "2026-11-06",
          openingMinor: 73_114_000,
          closingMinor: 69_990_000,
          days: [
            { day: "2026-11-05", trips: [{ number: 241, amountMinor: 3_130_465 }], chargedMinor: 3_130_465, paidMinor: 1_768_800, closingMinor: 74_475_665 },
            { day: "2026-11-06", trips: [], chargedMinor: 0, paidMinor: 0, closingMinor: 74_475_665 },
          ],
          refunds: [{ code: "3", name: "Рахим", amountMinor: 5_000 }],
          events: {
            closed: [{ code: "66", name: "Тимур" }],
            paidTrip: [
              { code: "594", name: "Марсел", trip: 246, amountMinor: 114_300, daysAfter: 1, closed: false },
              { code: "629", name: "Костантин", trip: 246, amountMinor: 79_700, daysAfter: 1, closed: true },
              { code: "476", name: "Ирина", trip: 246, amountMinor: 153_700, daysAfter: 0, closed: false },
              { code: "13", name: "Сирожидин", trip: 244, amountMinor: 49_200, daysAfter: 4, closed: true },
            ],
            firstPayment: [
              { code: "5", name: "Марсел", amountMinor: 114_300, previousDay: null },
              { code: "7", name: "Саша", amountMinor: 30_000, previousDay: "2026-08-14" },
            ],
            crossed: { boundaryMinor: 70_000_000, down: true },
          },
        }),
      ),
    );
    expect(notes).toEqual([
      "Закрытие 04.11 не сохранено — правки задним числом не проверялись.",
      "05.11 — рейс 241 +31 305, оплачено 17 688 → долг 744 757; 06.11 — без движения → долг 744 757.",
      "Оплатили рейс 246 на следующий день: Марсел (594) 1 143, Костантин (629) 797.",
      "Оплатили рейс 246 в день прибытия: Ирина (476) 1 537.",
      "Оплатили рейс 244 через 4 дн.: Сирожидин (13) 492.",
      "Закрыли долг: Тимур (66).",
      "Первая оплата в 2026: Марсел (5) 1 143.",
      "Первая оплата после перерыва: Саша (7) 300 (прошлая 14.08).",
      "Возвращено клиентам: Рахим (3) 50.",
      "Долг опустился ниже 700 тыс.",
    ]);
    expect(plainAll(movementNotes(quiet({ events: { closed: [], paidTrip: [], firstPayment: [], crossed: { boundaryMinor: 75_000_000, down: false } } })))[1]).toBe("Долг поднялся выше 750 тыс.");
    // A history that began in another year: no payment at all is said without the year.
    const old = quiet({ historyFrom: "2025-01-01", events: { closed: [], paidTrip: [], firstPayment: [{ code: "5", name: "Марсел", amountMinor: 114_300, previousDay: "2025-12-20" }], crossed: null } });
    expect(plainAll(movementNotes(old))[1]).toBe("Первая оплата после перерыва: Марсел (5) 1 143 (прошлая 20.12.25).");
    expect(neverPaid(old)).toBe("оплат нет");
    expect(neverPaid(quiet())).toBe("в 2026 нет");
  });

  it("say of the thirty who owe most how much of the debt is theirs, who came, who went and who is close to thirty days", () => {
    const row = (place: number, code: string) => ({ place, code, name: "К", debtMinor: 1_000_000, changeMinor: 0, lastPaidDay: "2026-11-10", daysUnpaid: 6, isNew: false });
    const report = quiet({
      debtors: { count: 157, totalMinor: 70_854_810 },
      top: {
        rows: Array.from({ length: 30 }, (_, index) => row(index + 1, String(index + 1))),
        totalMinor: 47_931_669,
        left: [
          { code: "795", name: "Дилмурод", paidMinor: 300_000, debtMinor: 883_699, changeMinor: -300_000 },
          { code: "66", name: "Тимур", paidMinor: 24_700, debtMinor: 0, changeMinor: -24_700 },
          { code: "9", name: "Олим", paidMinor: 0, debtMinor: 880_000, changeMinor: 0 },
        ],
        entered: [
          { code: "606", name: "Насиба", chargedMinor: 0, trips: [], changeMinor: 0 },
          { code: "200", name: "Шухрад", chargedMinor: 2_312_900, trips: [245], changeMinor: 2_312_900 },
          { code: "369", name: "Захар", chargedMinor: 678_200, trips: [245, 246], changeMinor: 678_200 },
        ],
        moved: [{ code: "200", name: "Шухрад", from: 5, to: 28 }],
        near: [{ code: "173", name: "Хажи", days: 21 }, { code: "658", name: "Косим", days: 25 }],
        crossed: [{ code: "731", name: "Аброр", days: 30 }],
      },
    });
    expect(plainAll(topNotes(report))).toEqual([
      "Красным в последней колонке — оплаты не было 30 дней и больше.",
      "Всего должников 157, их долг 708 548 $; на топ-30 приходится 479 317 $ (68%).",
      "Вышли из списка: Дилмурод (795) — оплата 3 000, осталось 8 837, Тимур (66) — оплата 247, долг закрыт, Олим (9) — долг не менялся, место заняли другие.",
      "Вошли в список: Насиба (606) — без изменений долга, Шухрад (200) — рейс 245 на 23 129, Захар (369) — рейсы 245, 246 на 6 782.",
      "Шухрад (200): с 5-го на 28-е место.",
      "Перешли порог 30 дней: Аброр (731) — 30.",
      "Близко к порогу 30 дней: Косим (658) — 25, Хажи (173) — 21.",
    ]);
    // Fewer debtors than the list is long: nothing to compare the list with.
    const few = quiet({ debtors: { count: 2, totalMinor: 150_000 }, top: { ...report.top, rows: report.top.rows.slice(0, 2), totalMinor: 150_000, left: [], entered: [], moved: [], near: [], crossed: [] } });
    expect(plainAll(topNotes(few))).toEqual(["Красным в последней колонке — оплаты не было 30 дней и больше.", "Всего должников 2, их долг 1 500 $.", "Состав списка не изменился."]);
    expect(topNotes(quiet())).toEqual(["Должников нет."]);
    // Written into the past: who is among the thirty of the day before now.
    const kept = { takenAt: "2026-11-16T00:05:00.000Z", thenMinor: 1, changes: [{ code: "4", name: "Тимур", changeMinor: 60_000 }], trips: [], topIn: [{ code: "4", name: "Тимур" }], topOut: [{ code: "9", name: "Олим" }], overdueIn: [], overdueOut: [] };
    expect(plainAll(topNotes({ ...few, backdated: kept })).at(-1)).toBe("После правок задним числом в списке на 15.11: вошли Тимур (4); вышли Олим (9).");
  });

  it("say of those who do not pay how they are chosen, who is new and why, who left, and who still got cargo", () => {
    const row = (code: string, name: string, more: Partial<DebtReport["overdue"]["rows"][number]> = {}) => ({ code, name, debtMinor: 98_403, lastPaidDay: "2026-10-17" as string | null, daysUnpaid: 30, lastTripDay: null, isNew: false, gotCargo: false, ...more });
    const report = quiet({
      overdue: {
        rows: [row("659", "Саша", { daysUnpaid: 94, gotCargo: true }), row("731", "Аброр", { isNew: true }), row("836", "Ахмад", { lastPaidDay: null, daysUnpaid: 319 })],
        totalMinor: 500_000,
        long: 2,
        left: [
          { code: "7", name: "Рахим", paidMinor: 50_000, debtMinor: 40_000 },
          { code: "8", name: "Олим", paidMinor: 0, debtMinor: 45_000 },
        ],
        came: [
          { code: "731", name: "Аброр", debtMinor: 98_403, daysUnpaid: 30, lastPaidDay: "2026-10-17", reason: "days" },
          { code: "12", name: "Бахтиёр", debtMinor: 61_000, daysUnpaid: 45, lastPaidDay: "2026-10-02", reason: "debt" },
        ],
      },
    });
    expect(plainAll(overdueNotes(report))).toEqual([
      "Отбор: долг на 16.11 больше 500 $ и последняя оплата 30 и больше дней назад.",
      "«В 2026 нет» — с 01.01 ни одной оплаты (дни от 01.01).",
      "Новые: Аброр (731) — 984, 30 дней без оплаты (последняя 17.10), Бахтиёр (12) — после рейса долг 610, больше 500.",
      "Вышли из списка: Рахим (7) — оплата 500, осталось 400, Олим (8) — долг стал 450.",
      "Получили груз 16.11 и не платят: Саша (659) — 94 дн. без оплаты.",
    ]);
    expect(plainAll(overdueNotes(quiet()))).toEqual(["Отбор: долг на 16.11 больше 500 $ и последняя оплата 30 и больше дней назад.", "Состав списка не изменился."]);
  });

  it("say up to which day the last month of the control sheet runs, and warn when it does not come to the debt of all", () => {
    const month = { month: "2026-11", openingMinor: 70_988_759, chargedMinor: 24_533_601, paidMinor: 24_845_000, closingMinor: 70_677_359 };
    expect(controlNotes(quiet({ control: { year: 2026, months: [month], agrees: true } }))).toEqual(["Ноябрь — по 16.11 включительно."]);
    // The last day of the month: the month is whole.
    expect(controlNotes(quiet({ day: "2026-11-30", control: { year: 2026, months: [month], agrees: true } }))).toEqual([]);
    expect(plainAll(controlNotes(quiet({ day: "2026-11-30", closingMinor: 70_677_400, control: { year: 2026, months: [month], agrees: false } })))).toEqual([
      "Внимание: остаток на конец месяца (706 773,59) не сходится с долгом всех клиентов на 30.11 (706 774,00).",
    ]);
  });
});

describe("the picture of a month", () => {
  it("marks an axis with round numbers that hold everything drawn", () => {
    expect(axisTicks(699_945, 744_757)).toEqual([680_000, 700_000, 720_000, 740_000, 760_000]);
    expect(axisTicks(0, 638_795, 3)).toEqual([0, 500_000, 1_000_000]);
    expect(axisTicks(0, 245_336, 3)).toEqual([0, 100_000, 200_000, 300_000]);
    expect(axisTicks(26_584, 31_974)).toEqual([26_000, 28_000, 30_000, 32_000]);
    expect(axisTicks(120, 180)).toEqual([120, 140, 160, 180]);
    // Nothing moved all month: an axis all the same.
    expect(axisTicks(500, 500)).toEqual([500, 501]);
    // Thousands in short where every mark is a whole thousand, in full where not.
    expect(plain(axisLabel(700_000, [680_000, 700_000]))).toBe("700 тыс.");
    expect(plain(axisLabel(1_000_000, [0, 500_000, 1_000_000]))).toBe("1 000 тыс.");
    expect(axisLabel(0, [0, 500_000])).toBe("0");
    expect(plain(axisLabel(1_500, [1_000, 1_500, 2_000]))).toBe("1 500");
  });

  it("says when the debt was biggest and smallest, and how many trucks came", () => {
    expect(dynamicsNotes(quiet())).toEqual([]);
    const days = [
      { day: "2026-11-01", chargedMinor: 0, paidMinor: 1_000_000, closingMinor: 70_000_000 },
      { day: "2026-11-02", chargedMinor: 4_475_700, paidMinor: 0, closingMinor: 74_475_700 },
      { day: "2026-11-03", chargedMinor: 0, paidMinor: 4_481_200, closingMinor: 69_994_500 },
    ];
    expect(plainAll(dynamicsNotes(quiet({ dynamics: { month: "2026-11", openingMinor: 71_000_000, trips: 7, days } })))).toEqual([
      "Самый большой долг за месяц — 744 757 (02.11), самый маленький — 699 945 (03.11).",
      "Рейсов прибыло: 7.",
      "Под названием месяца — остаток на конец месяца, тыс. $.",
    ]);
  });
});
