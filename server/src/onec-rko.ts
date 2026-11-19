import type { Json, OneCClient, OneCSettings } from "./onec-api.js";

export const EXPENSE_ENTITY = "Document_РасходныйКассовыйОрдер";
export const DEPARTMENT_ENTITY = "Catalog_ПодразделенияОрганизаций";

type Item = { key: string; name: string };

/** What the base has that an expense order refers to: its accounts and the lists its accountant files expenses under. */
export type ExpenseLists = {
  accounts: { cash: string; production: string; other: string };
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
