import { toUsdMinor } from "./money.js";
import type { Json, OneCClient, OneCSettings } from "./onec-api.js";

/** The latin letters that look like cyrillic ones: the codes of clients are written with either. */
const LATIN_TO_CYRILLIC: Record<string, string> = { A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", a: "а", c: "с", e: "е", o: "о", p: "р", x: "х" };
const cyrillic = (text: string) => text.replace(/[ABCEHKMOPTXaceopx]/g, (letter) => LATIN_TO_CYRILLIC[letter]!);

export type ClientCode = {
  /** "А245": the letter is cyrillic, as the clients are named in 1C. */
  code: string;
  /** What follows the code ("А466 Светлана"), to tell two clients of one code apart; empty when nothing does. */
  name: string;
};

/**
 * The code of a client out of what a cashier typed: "A245", "а-245", "A 245 Исмоил" all are клиент А245. A text that
 * is not a code ("А чужой пул", "Москва") is none.
 */
export function clientCodeOf(text: string | null): ClientCode | null {
  const found = /^([AaАа])\s*-?\s*(\d{1,5})(?:\s+(\D.*))?$/.exec((text ?? "").trim());
  return found ? { code: `А${found[2]}`, name: (found[3] ?? "").trim() } : null;
}

type Counterpart = { key: string; name: string };

export type Lookup =
  | { found: true; counterpart: Counterpart; contract: { key: string; name: string } }
  | { found: false; reason: string };

/** The key a counterpart is known by: its name starts with the code ("А245 Исмоил"), or its tax number is the number of the code. */
function keysOf(row: Json): string[] {
  const name = cyrillic(String(row.Description ?? ""));
  const keys: string[] = [];
  const byName = /^\s*([AaАа])\s*-?\s*(\d{1,5})\b/.exec(name);
  if (byName) keys.push(`А${byName[2]}`);
  const tax = String(row["ИНН"] ?? "").replace(/\D/g, "");
  if (tax !== "" && Number(tax) < 100_000) keys.push(`А${Number(tax)}`);
  return keys;
}

/**
 * Finds the counterpart and the contract of a client in 1C, the way the cash books were loaded: by the code, never by
 * guessing. Two clients of one code, or none, or no contract, is a question for a person, not a choice for the program.
 */
export function pickCounterpart(
  counterparts: readonly Json[],
  client: ClientCode,
): { found: true; counterpart: Counterpart } | { found: false; reason: string } {
  const live = counterparts.filter((row) => row.DeletionMark !== true && row.IsFolder !== true);
  let candidates = live.filter((row) => keysOf(row).includes(client.code));
  if (candidates.length === 0) return { found: false, reason: `в 1С нет контрагента с кодом ${client.code}` };
  if (client.name !== "") {
    const named = candidates.filter((row) => String(row.Description ?? "").toLowerCase().includes(client.name.toLowerCase()));
    if (named.length === 0) {
      const names = candidates.map((row) => String(row.Description)).join("; ");
      return { found: false, reason: `имя «${client.name}» не совпало с контрагентами кода ${client.code}: ${names}` };
    }
    candidates = named;
  }
  if (candidates.length > 1) {
    return { found: false, reason: `на код ${client.code} несколько контрагентов: ${candidates.map((row) => String(row.Description)).join("; ")}` };
  }
  const only = candidates[0]!;
  return { found: true, counterpart: { key: String(only.Ref_Key), name: String(only.Description) } };
}

/** The contract of the client: "№А245 от 01.01.2026", or else any contract with a buyer. */
export function pickContract(contracts: readonly Json[], code: string): { key: string; name: string } | null {
  const live = contracts.filter((row) => row.DeletionMark !== true);
  const own = live.find((row) => String(row.Description ?? "").startsWith(`№${code} `));
  const found = own ?? live.find((row) => row["ВидДоговора"] === "СПокупателем");
  return found ? { key: String(found.Ref_Key), name: String(found.Description) } : null;
}

/** What the document is worth in dollars (cents): rubles at the rate of the entry, dollars as they are. Null while there is no rate. */
export function dollarsOf(entry: { currency: "RUB" | "USD"; amountMinor: number; rateE4: number | null }): number | null {
  if (entry.currency === "USD") return entry.amountMinor;
  return entry.rateE4 === null ? null : toUsdMinor(entry.amountMinor, entry.rateE4);
}

/** The keys that the documents refer to; looked up in 1C by name and by code of account. */
export type References = {
  accounts: { cash: string; settlements: string; advances: string };
  paymentFromBuyer: string;
};

/** "2026-10-02T14:21:03": the moment in Moscow time, as 1C writes the date of a document. */
export function documentDate(instant: Date): string {
  return new Date(instant.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 19);
}

export type Receipt = {
  date: string;
  dollarsMinor: number;
  /** The client's code as written in 1C: the comment of the document. */
  comment: string;
};

/**
 * The body of the cash receipt "Оплата покупателя" as the cash books were loaded with it: cash 5010, the currency
 * "Доллар" at rate 1, the item "Оплата от покупателей", no VAT, one line of the payment with the contract; no sales in
 * the base, so the money lies as an advance, Дт 5010 / Кт 6310.
 */
export function receiptBody(settings: OneCSettings, refs: References, receipt: Receipt, who: { counterpart: Counterpart; contractKey: string }): Json {
  const sum = receipt.dollarsMinor / 100;
  return {
    Date: receipt.date,
    ВидОперации: "ОплатаПокупателя",
    Организация_Key: settings.organizationKey,
    СуммаДокумента: sum,
    ВалютаДокумента_Key: settings.currencyKey,
    СчетКасса_Key: refs.accounts.cash,
    КассаОрганизации_Key: settings.kassaKey,
    Контрагент: who.counterpart.key,
    Контрагент_Type: "StandardODATA.Catalog_Контрагенты",
    ДоговорКонтрагента_Key: who.contractKey,
    ПринятоОт: who.counterpart.name,
    СтатьяДвиженияДенежныхСредств_Key: refs.paymentFromBuyer,
    СтавкаНДС: "БезНДС",
    Содержание_УСН: "Оплата от покупателя.",
    Комментарий: receipt.comment,
    РасшифровкаПлатежа: [
      {
        LineNumber: "1",
        ДоговорКонтрагента_Key: who.contractKey,
        СпособПогашенияЗадолженности: "Автоматически",
        СуммаПлатежа: sum,
        КурсВзаиморасчетов: 1,
        КратностьВзаиморасчетов: 1,
        СуммаВзаиморасчетов: sum,
        СтавкаНДС: "БезНДС",
        СуммаНДС: 0,
        СтатьяДвиженияДенежныхСредств_Key: refs.paymentFromBuyer,
        СчетУчетаРасчетовСКонтрагентом_Key: refs.accounts.settlements,
        СчетУчетаРасчетовПоАвансам_Key: refs.accounts.advances,
      },
    ],
  };
}

export const RECEIPT_ENTITY = "Document_ПриходныйКассовыйОрдер";
export const POSTINGS_ENTITY = "AccountingRegister_Хозрасчетный";

/** Whether the postings of a document are what a payment of a client makes: Дт 5010, Кт 6310 (an advance) or 4010 (a debt), for the sum. */
export function postingIsRight(rows: readonly Json[], codeOf: ReadonlyMap<string, string>, dollarsMinor: number): boolean {
  if (rows.length === 0) return false;
  const total = rows.reduce((sum, row) => sum + Math.round(Number(row["Сумма"]) * 100), 0);
  return (
    total === dollarsMinor &&
    rows.every((row) => codeOf.get(String(row.AccountDr_Key)) === "5010" && ["6310", "4010"].includes(codeOf.get(String(row.AccountCr_Key)) ?? ""))
  );
}

/** Reads the keys of the accounts and of the item of the payments of buyers; says what is missing. */
export async function readReferences(client: OneCClient): Promise<{ refs: References; codeOf: Map<string, string> } | { missing: string }> {
  const accounts = await client.all("ChartOfAccounts_Хозрасчетный", "Ref_Key,Code");
  const byCode = new Map(accounts.map((row) => [String(row.Code), String(row.Ref_Key)]));
  const codeOf = new Map(accounts.map((row) => [String(row.Ref_Key), String(row.Code)]));
  const items = await client.all("Catalog_СтатьиДвиженияДенежныхСредств", "Ref_Key,Description,DeletionMark");
  const payment = items.find((row) => row.DeletionMark !== true && row.Description === "Оплата от покупателей");
  for (const code of ["5010", "4010", "6310"]) if (!byCode.has(code)) return { missing: `в плане счетов нет счёта ${code}` };
  if (!payment) return { missing: "в справочнике статей ДДС нет статьи «Оплата от покупателей»" };
  return {
    refs: {
      accounts: { cash: byCode.get("5010")!, settlements: byCode.get("4010")!, advances: byCode.get("6310")! },
      paymentFromBuyer: String(payment.Ref_Key),
    },
    codeOf,
  };
}
