import type { Json, OneCClient, OneCSettings } from "./onec-api.js";

export const EXPENSE_ENTITY = "Document_РасходныйКассовыйОрдер";
export const DEPARTMENT_ENTITY = "Catalog_ПодразделенияОрганизаций";

type Item = { key: string; name: string };

/** What the base has that an expense order refers to: its accounts and the lists its accountant files expenses under. */
export type ExpenseLists = {
  accounts: { cash: string; production: string; other: string };
  /** Every account of the chart by its code: the kinds of orders that are not an expense have accounts of their own. */
  accountOf: ReadonlyMap<string, string>;
  /** «Статьи движения денежных средств». */
  flowItems: readonly Item[];
  /** «Статьи затрат»: what an expense of a trip is filed under, on the account of production. */
  costItems: readonly Item[];
  /** «Прочие доходы и расходы»: what an expense of no trip is filed under. */
  otherItems: readonly Item[];
  /** «Номенклатурные группы». */
  groups: readonly Item[];
  /** «Подразделения»: every trip is one, named by its number. */
  departments: readonly Item[];
};

/** The accounts of an expense: the cash, the production (the cost of a trip) and the other expenses. */
export const EXPENSE_ACCOUNTS = { cash: "5010", production: "2010", other: "9430" } as const;
const MAIN_GROUP = "Основная группа";
const OTHER_COST = "Прочие расходы";
const OTHER_EXPENSE = "Прочие внереализационные доходы (расходы)";

/** Names are compared as a person reads them: «Толкач » is «толкач». */
const plain = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
const named = (items: readonly Item[], name: string) => items.find((item) => plain(item.name) === plain(name));

async function itemsOf(client: OneCClient, entity: string): Promise<Item[]> {
  const rows = await client.all(entity, "Ref_Key,Description,DeletionMark");
  return rows.filter((row) => row.DeletionMark !== true).map((row) => ({ key: String(row.Ref_Key), name: String(row.Description ?? "") }));
}

/** Reads the lists of the base; says what an expense order cannot do without. */
export async function readExpenseLists(client: OneCClient): Promise<{ lists: ExpenseLists } | { missing: string }> {
  const accounts = await client.all("ChartOfAccounts_Хозрасчетный", "Ref_Key,Code");
  const byCode = new Map(accounts.map((row) => [String(row.Code).trim(), String(row.Ref_Key)]));
  for (const code of Object.values(EXPENSE_ACCOUNTS)) if (!byCode.has(code)) return { missing: `в плане счетов нет счёта ${code}` };
  return {
    lists: {
      accountOf: byCode,
      accounts: { cash: byCode.get(EXPENSE_ACCOUNTS.cash)!, production: byCode.get(EXPENSE_ACCOUNTS.production)!, other: byCode.get(EXPENSE_ACCOUNTS.other)! },
      flowItems: await itemsOf(client, "Catalog_СтатьиДвиженияДенежныхСредств"),
      costItems: await itemsOf(client, "Catalog_СтатьиЗатрат"),
      otherItems: await itemsOf(client, "Catalog_ПрочиеДоходыИРасходы"),
      groups: await itemsOf(client, "Catalog_НоменклатурныеГруппы"),
      departments: await itemsOf(client, DEPARTMENT_ENTITY),
    },
  };
}

export type Expense = {
  /** What the category of the expense is called in the cash desk: the items of the base are looked for by it. */
  label: string;
  tripNumber: number | null;
  /** What the cash desk that paid is called: «Москва». The other expenses of the base are kept by city. */
  kassaName: string;
};

/** Where an expense goes in the books of the base. */
export type Placement =
  | { account: "production"; group: Item; cost: Item; flow: Item; trip: number; words: string }
  | { account: "other"; other: Item; flow: Item; words: string };

/**
 * Places an expense the way the accountant of the base does. An expense of a trip whose category is an item of costs
 * there («Толкач», «Услуги водителя точка Б») is a cost of that trip: the account of production, that item, the
 * department of the trip. A category that is an item of other expenses («Обед») goes there, trip or not. Any other
 * expense of a trip is its cost under «Прочие расходы»; any other expense of no trip is an other expense of the city.
 * The item of the cash flow is the one of the same name, or else «Прочие расходы» of the city of the desk.
 */
export function placeExpense(lists: ExpenseLists, expense: Expense): Placement | { reason: string } {
  const cityFlow = `Прочие расходы ${expense.kassaName}`;
  const flow = named(lists.flowItems, expense.label) ?? named(lists.flowItems, cityFlow);
  if (!flow) return { reason: `в 1С нет статьи движения денег «${expense.label}» и нет статьи «${cityFlow}»` };
  const cost = named(lists.costItems, expense.label);
  const other = named(lists.otherItems, expense.label);
  const production = (item: Item, trip: number): Placement | { reason: string } => {
    const group = named(lists.groups, MAIN_GROUP);
    if (!group) return { reason: `в 1С нет номенклатурной группы «${MAIN_GROUP}»` };
    return { account: "production", group, cost: item, flow, trip, words: `счёт ${EXPENSE_ACCOUNTS.production}, статья затрат «${item.name}», рейс ${trip}, статья денег «${flow.name}»` };
  };
  if (expense.tripNumber !== null && cost) return production(cost, expense.tripNumber);
  if (other) return { account: "other", other, flow, words: `счёт ${EXPENSE_ACCOUNTS.other}, «${other.name}», статья денег «${flow.name}»` };
  if (expense.tripNumber !== null) {
    const rest = named(lists.costItems, OTHER_COST);
    if (!rest) return { reason: `в 1С нет статьи затрат «${expense.label}» и нет статьи «${OTHER_COST}»` };
    return production(rest, expense.tripNumber);
  }
  const rest = named(lists.otherItems, OTHER_EXPENSE);
  if (!rest) return { reason: `в справочнике прочих доходов и расходов 1С нет «${OTHER_EXPENSE}»` };
  return { account: "other", other: rest, flow, words: `счёт ${EXPENSE_ACCOUNTS.other}, «${rest.name}», статья денег «${flow.name}»` };
}

/** The department of a trip: the one named by its number. */
export const departmentOf = (lists: ExpenseLists, trip: number) => named(lists.departments, String(trip));

export type ExpenseOrder = { date: string; dollarsMinor: number; comment: string; recipient: string };

/**
 * The body of the expense order «Прочий расход» as the accountant of the base fills it in: cash 5010 against the
 * account of the placement with what it is filed under; for a cost of a trip, the department of the trip.
 */
export function expenseBody(settings: Pick<OneCSettings, "organizationKey" | "currencyKey" | "kassaKey">, lists: ExpenseLists, order: ExpenseOrder, placement: Placement, department: string | undefined): Json {
  const none = "00000000-0000-0000-0000-000000000000";
  const filed =
    placement.account === "production"
      ? {
          СчетУчетаРасчетовСКонтрагентом_Key: lists.accounts.production,
          СубконтоДт1: placement.group.key,
          СубконтоДт1_Type: "StandardODATA.Catalog_НоменклатурныеГруппы",
          СубконтоДт2: placement.cost.key,
          СубконтоДт2_Type: "StandardODATA.Catalog_СтатьиЗатрат",
          ПодразделениеОрганизации_Key: department ?? none,
          ПодразделениеДт_Key: department ?? none,
        }
      : {
          СчетУчетаРасчетовСКонтрагентом_Key: lists.accounts.other,
          СубконтоДт1: placement.other.key,
          СубконтоДт1_Type: "StandardODATA.Catalog_ПрочиеДоходыИРасходы",
          СубконтоДт2: "",
          СубконтоДт2_Type: "StandardODATA.Undefined",
          ПодразделениеОрганизации_Key: none,
          ПодразделениеДт_Key: none,
        };
  return {
    Date: order.date,
    ВидОперации: "ПрочийРасход",
    Организация_Key: settings.organizationKey,
    СчетКасса_Key: lists.accounts.cash,
    КассаОрганизации_Key: settings.kassaKey,
    СуммаДокумента: order.dollarsMinor / 100,
    ВалютаДокумента_Key: settings.currencyKey,
    ...filed,
    СтатьяДвиженияДенежныхСредств_Key: placement.flow.key,
    Выдать: order.recipient,
    Комментарий: order.comment,
  };
}

/** The fields that make an expense order what it is: a document that differs in one of them is corrected. */
export const EXPENSE_FIELDS = [
  "СчетУчетаРасчетовСКонтрагентом_Key",
  "СубконтоДт1",
  "СубконтоДт2",
  "ПодразделениеОрганизации_Key",
  "ПодразделениеДт_Key",
  "СтатьяДвиженияДенежныхСредств_Key",
  "КассаОрганизации_Key",
  "Выдать",
] as const;

/** Whether the postings of a document are what this expense makes: the account of its placement against the cash, for the sum. */
export function expensePostingIsRight(rows: readonly Json[], codeOf: ReadonlyMap<string, string>, placement: Placement, dollarsMinor: number): boolean {
  if (rows.length === 0) return false;
  const total = rows.reduce((sum, row) => sum + Math.round(Number(row["Сумма"]) * 100), 0);
  const debit = EXPENSE_ACCOUNTS[placement.account];
  return total === dollarsMinor && rows.every((row) => codeOf.get(String(row.AccountDr_Key)) === debit && codeOf.get(String(row.AccountCr_Key)) === EXPENSE_ACCOUNTS.cash);
}

/** The accounts of what is paid out but is no expense: the dividends of the owner, a supplier's debt and advance. */
export const PAYOUT_ACCOUNTS = { dividends: "6610", suppliers: "6010", supplierAdvances: "4310" } as const;
const DIVIDENDS_FLOW = "Выплата дивидендов";
const SUPPLIERS_FLOW = "Оплата поставщикам (подрядчикам)";

type Common = Pick<OneCSettings, "organizationKey" | "currencyKey" | "kassaKey">;
const header = (settings: Common, lists: ExpenseLists, order: ExpenseOrder): Json => ({
  Date: order.date,
  Организация_Key: settings.organizationKey,
  СчетКасса_Key: lists.accounts.cash,
  КассаОрганизации_Key: settings.kassaKey,
  СуммаДокумента: order.dollarsMinor / 100,
  ВалютаДокумента_Key: settings.currencyKey,
  Комментарий: order.comment,
});

/**
 * Money handed to the owner, as the base keeps it: «Выплата дивидендов или процентов» to the founder, against the
 * account of dividends. `founder`: who the last such order of the base was to.
 */
export function dividendsBody(settings: Common, lists: ExpenseLists, order: ExpenseOrder, founder: string): Json | { reason: string } {
  const account = lists.accountOf.get(PAYOUT_ACCOUNTS.dividends);
  if (!account) return { reason: `в плане счетов нет счёта ${PAYOUT_ACCOUNTS.dividends}` };
  const flow = named(lists.flowItems, DIVIDENDS_FLOW);
  if (!flow) return { reason: `в 1С нет статьи движения денег «${DIVIDENDS_FLOW}»` };
  return {
    ...header(settings, lists, order),
    ВидОперации: "ВыплатаДивидендовИлиПроцентов",
    Контрагент: founder,
    Контрагент_Type: "StandardODATA.Catalog_Контрагенты",
    СтатьяДвиженияДенежныхСредств_Key: flow.key,
    Выдать: order.recipient || "Учредитель",
    СуммаВыплаты: order.dollarsMinor / 100,
    СчетРасчетовКонтрагентов_Key: account,
    ТипВыплатыДивидендовИлиПроцентов: "Дивиденды",
  };
}

/** A payment to a supplier, as the base keeps it: «Оплата поставщику» with the counterpart and their contract, one line of the payment. */
export function supplierBody(settings: Common, lists: ExpenseLists, order: ExpenseOrder, who: { counterpart: string; name: string; contract: string }): Json | { reason: string } {
  const debt = lists.accountOf.get(PAYOUT_ACCOUNTS.suppliers);
  const advance = lists.accountOf.get(PAYOUT_ACCOUNTS.supplierAdvances);
  if (!debt || !advance) return { reason: `в плане счетов нет счёта ${PAYOUT_ACCOUNTS.suppliers} или ${PAYOUT_ACCOUNTS.supplierAdvances}` };
  const flow = named(lists.flowItems, SUPPLIERS_FLOW);
  if (!flow) return { reason: `в 1С нет статьи движения денег «${SUPPLIERS_FLOW}»` };
  const sum = order.dollarsMinor / 100;
  return {
    ...header(settings, lists, order),
    ВидОперации: "ОплатаПоставщику",
    Контрагент: who.counterpart,
    Контрагент_Type: "StandardODATA.Catalog_Контрагенты",
    ДоговорКонтрагента_Key: who.contract,
    СтатьяДвиженияДенежныхСредств_Key: flow.key,
    СтавкаНДС: "БезНДС",
    Выдать: order.recipient || who.name,
    РасшифровкаПлатежа: [
      {
        LineNumber: "1",
        ДоговорКонтрагента_Key: who.contract,
        СпособПогашенияЗадолженности: "Автоматически",
        СуммаПлатежа: sum,
        КурсВзаиморасчетов: 1,
        КратностьВзаиморасчетов: "1",
        СуммаВзаиморасчетов: sum,
        СтавкаНДС: "БезНДС",
        СуммаНДС: 0,
        СтатьяДвиженияДенежныхСредств_Key: flow.key,
        СчетУчетаРасчетовСКонтрагентом_Key: debt,
        СчетУчетаРасчетовПоАвансам_Key: advance,
      },
    ],
  };
}

/** Whether the postings of an order debit only the accounts named, against the cash, for the sum. */
export function payoutPostingIsRight(rows: readonly Json[], codeOf: ReadonlyMap<string, string>, debits: readonly string[], dollarsMinor: number): boolean {
  if (rows.length === 0) return false;
  const total = rows.reduce((sum, row) => sum + Math.round(Number(row["Сумма"]) * 100), 0);
  return total === dollarsMinor && rows.every((row) => debits.includes(codeOf.get(String(row.AccountDr_Key)) ?? "") && codeOf.get(String(row.AccountCr_Key)) === EXPENSE_ACCOUNTS.cash);
}

/** The supplier a cashier named, among the counterparts of the base: by the whole name, as a person reads it. */
export function pickSupplier(counterparts: readonly Json[], name: string): { key: string; name: string } | { reason: string } {
  const found = counterparts.filter((row) => row.DeletionMark !== true && row.IsFolder !== true && plain(String(row.Description ?? "")) === plain(name));
  if (found.length === 0) return { reason: `в 1С нет контрагента с названием «${name.trim()}»: поставщик в Кассе пишется так же, как в 1С` };
  if (found.length > 1) return { reason: `в 1С несколько контрагентов с названием «${name.trim()}»` };
  return { key: String(found[0]!.Ref_Key), name: String(found[0]!.Description) };
}

const TRANSFER_FLOW = "Внутреннее перемещение денежных средств";

/** Money moved to another cash desk: «Прочий расход», the cash against the cash, filed under the item of moving money and the desk it went to. */
export function transferBody(settings: Common, lists: ExpenseLists, order: ExpenseOrder, toKassaKey: string): Json | { reason: string } {
  const flow = named(lists.flowItems, TRANSFER_FLOW);
  if (!flow) return { reason: `в 1С нет статьи движения денег «${TRANSFER_FLOW}»` };
  const none = "00000000-0000-0000-0000-000000000000";
  return {
    ...header(settings, lists, order),
    ВидОперации: "ПрочийРасход",
    СчетУчетаРасчетовСКонтрагентом_Key: lists.accounts.cash,
    СубконтоДт1: flow.key,
    СубконтоДт1_Type: "StandardODATA.Catalog_СтатьиДвиженияДенежныхСредств",
    СубконтоДт2: toKassaKey,
    СубконтоДт2_Type: "StandardODATA.Catalog_КассыОрганизаций",
    ПодразделениеОрганизации_Key: none,
    ПодразделениеДт_Key: none,
    СтатьяДвиженияДенежныхСредств_Key: flow.key,
    Выдать: order.recipient,
  };
}
