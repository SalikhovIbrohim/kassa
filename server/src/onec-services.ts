import type { Json, OneCClient, OneCSettings } from "./onec-api.js";

export const SERVICE_ENTITY = "Document_ОказаниеУслуг";

/** The accounts of the services of a trip: the income, the cost, what the clients owe and what they paid ahead. */
export const SERVICE_ACCOUNTS = { income: "9030.1", cost: "9130.1", settlements: "4010", advances: "6310" } as const;
/** The service the clients of a trip are charged for, and the group it is of, as the base names them. */
const SERVICE_ITEM = "Рейс";
const MAIN_GROUP = "Основная группа";

export type ServiceReferences = {
  accounts: Record<keyof typeof SERVICE_ACCOUNTS, string>;
  /** The service «Рейс» of the list of goods and services. */
  item: string;
  group: string;
};

/** Reads what the services of a trip refer to; says what is missing. */
export async function readServiceReferences(client: OneCClient): Promise<{ refs: ServiceReferences; codeOf: Map<string, string> } | { missing: string }> {
  const accounts = await client.all("ChartOfAccounts_Хозрасчетный", "Ref_Key,Code");
  const byCode = new Map(accounts.map((row) => [String(row.Code).trim(), String(row.Ref_Key)]));
  for (const code of Object.values(SERVICE_ACCOUNTS)) if (!byCode.has(code)) return { missing: `в плане счетов нет счёта ${code}` };
  const live = (rows: Json[], name: string) => rows.find((row) => row.DeletionMark !== true && row.IsFolder !== true && String(row.Description ?? "").trim() === name);
  const item = live(await client.all("Catalog_Номенклатура", "Ref_Key,Description,DeletionMark,IsFolder"), SERVICE_ITEM);
  if (!item) return { missing: `в номенклатуре 1С нет услуги «${SERVICE_ITEM}»` };
  const group = live(await client.all("Catalog_НоменклатурныеГруппы", "Ref_Key,Description,DeletionMark"), MAIN_GROUP);
  if (!group) return { missing: `в 1С нет номенклатурной группы «${MAIN_GROUP}»` };
  return {
    refs: {
      accounts: {
        income: byCode.get(SERVICE_ACCOUNTS.income)!,
        cost: byCode.get(SERVICE_ACCOUNTS.cost)!,
        settlements: byCode.get(SERVICE_ACCOUNTS.settlements)!,
        advances: byCode.get(SERVICE_ACCOUNTS.advances)!,
      },
      item: String(item.Ref_Key),
      group: String(group.Ref_Key),
    },
    codeOf: new Map(accounts.map((row) => [String(row.Ref_Key), String(row.Code).trim()])),
  };
}

export type ServiceTrip = {
  number: number;
  /** "2026-11-19": the day the truck arrived, which is the day of the document. */
  arrivalDay: string;
  driverName: string | null;
  driverPhone: string | null;
  truckPlates: string | null;
};

/** A line of the waybill, with who in the base owes for it. */
export type ServiceLine = {
  counterpart: string;
  contract: string;
  weightG: number;
  priceMilli: number;
  bags: number | null;
  pieces: number | null;
  brand: string | null;
  sender: string | null;
  receiver: string | null;
  item: string | null;
  size: string | null;
};

/** What a line comes to, in cents: the weight by the price, to the nearest cent. */
export const lineCents = (line: Pick<ServiceLine, "weightG" | "priceMilli">) => Math.round((line.weightG * line.priceMilli) / 10_000);

const text = (value: string | number | null) => (value === null ? "" : String(value));

/**
 * The body of «Оказание услуг» of a trip as the base keeps them: one document to a trip, on the department of the
 * trip, dated the day the truck arrived, with the truck and the driver in its header and a line to every line of the
 * waybill: the client and the contract, the kilograms, the price of a kilogram, the sum, and what the cargo is.
 */
export function serviceBody(settings: Pick<OneCSettings, "organizationKey" | "currencyKey">, refs: ServiceReferences, trip: ServiceTrip, department: string, lines: readonly ServiceLine[]): Json {
  const rows = lines.map((line, index) => ({
    LineNumber: String(index + 1),
    Контрагент_Key: line.counterpart,
    ДоговорКонтрагента_Key: line.contract,
    Количество: line.weightG / 1000,
    Цена: line.priceMilli / 1000,
    Сумма: lineCents(line) / 100,
    СуммаНДС: 0,
    СчетУчетаРасчетовСКонтрагентом_Key: refs.accounts.settlements,
    СчетУчетаРасчетовПоАвансам_Key: refs.accounts.advances,
    Экс_Мест: text(line.bags),
    Экс_Бренд: text(line.brand),
    Экс_Отправитель: text(line.sender),
    Экс_Получатель: text(line.receiver),
    Экс_Наименование: [line.item, line.size].filter(Boolean).join(", "),
    Экс_Штук: text(line.pieces),
  }));
  return {
    Date: `${trip.arrivalDay}T12:00:00`,
    Организация_Key: settings.organizationKey,
    ПодразделениеОрганизации_Key: department,
    Номенклатура_Key: refs.item,
    ВалютаДокумента_Key: settings.currencyKey,
    СтавкаНДС: "БезНДС",
    СуммаВключаетНДС: false,
    СчетДоходов_Key: refs.accounts.income,
    Субконто: refs.group,
    Субконто_Type: "StandardODATA.Catalog_НоменклатурныеГруппы",
    СчетРасходов_Key: refs.accounts.cost,
    СуммаДокумента: lines.reduce((sum, line) => sum + lineCents(line), 0) / 100,
    КурсВзаиморасчетов: 1,
    КратностьВзаиморасчетов: "1",
    Комментарий: `Рейс ${trip.number}`,
    Экс_НомерМашины: text(trip.truckPlates),
    Экс_Водитель: text(trip.driverName),
    Экс_ТелефонВодителя: text(trip.driverPhone),
    Контрагенты: rows,
  };
}

const HEADER = ["ПодразделениеОрганизации_Key", "Номенклатура_Key", "ВалютаДокумента_Key", "СчетДоходов_Key", "СчетРасходов_Key", "Экс_НомерМашины", "Экс_Водитель", "Экс_ТелефонВодителя"] as const;
const LINE_TEXT = ["Контрагент_Key", "ДоговорКонтрагента_Key", "Экс_Мест", "Экс_Бренд", "Экс_Отправитель", "Экс_Получатель", "Экс_Наименование", "Экс_Штук"] as const;
const LINE_NUMBERS = ["Количество", "Цена", "Сумма"] as const;

/** Whether the document in the base says what the trip says now: its day, its header, and its lines one by one. */
export function sameService(known: Json, body: Json): boolean {
  const thousandths = (value: unknown) => Math.round(Number(value ?? 0) * 1000);
  if (String(known.Date ?? "").slice(0, 19) !== String(body.Date)) return false;
  if (HEADER.some((field) => String(known[field] ?? "") !== String(body[field] ?? ""))) return false;
  const have = (known["Контрагенты"] as Json[] | undefined) ?? [];
  const want = body["Контрагенты"] as Json[];
  return (
    have.length === want.length &&
    want.every((line, index) => LINE_TEXT.every((field) => String(have[index]![field] ?? "") === String(line[field] ?? "")) && LINE_NUMBERS.every((field) => thousandths(have[index]![field]) === thousandths(line[field])))
  );
}

/** Whether the postings of the document credit the income of services with what the trip comes to. */
export function servicePostingIsRight(rows: readonly Json[], codeOf: ReadonlyMap<string, string>, totalMinor: number): boolean {
  const income = rows.filter((row) => codeOf.get(String(row.AccountCr_Key)) === SERVICE_ACCOUNTS.income);
  return income.length > 0 && income.reduce((sum, row) => sum + Math.round(Number(row["Сумма"]) * 100), 0) === totalMinor;
}
