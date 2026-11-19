import type { Json, OneCClient } from "../onec-api.js";

/**
 * A look at a base of 1C that changes nothing in it: what it holds and how its documents are filled in. Before the
 * cash desk is taught to write to a base it has never seen (another company, another configuration), somebody has to
 * read that base: its organizations, cash desks and currencies, how its counterparties and contracts are named, the
 * items of its cash flow, its accounts, and a few of its own cash orders and sales as the accountant made them. This
 * prints all of that as text. Every question is asked by itself: one that the base refuses is said and passed over.
 */

/** The lists that are read whole (they are short), and what is read of each row. */
const WHOLE = [
  "Catalog_Организации",
  "Catalog_Кассы",
  "Catalog_Валюты",
  "Catalog_ПодразделенияОрганизаций",
  "Catalog_НоменклатурныеГруппы",
  "Catalog_Пользователи",
  "Catalog_СтатьиДвиженияДенежныхСредств",
  "Catalog_СтатьиЗатрат",
  "Catalog_ПрочиеДоходыИРасходы",
  "Catalog_ВидыНоменклатуры",
];
/** Of these documents the last few hundred are counted by how they are filled in: which kinds, accounts, items and desks go together. */
const COUNTED: Record<string, string[]> = {
  Document_РасходныйКассовыйОрдер: ["ВидОперации", "СчетУчетаРасчетовСКонтрагентом_Key", "СубконтоДт1", "СубконтоДт2", "СубконтоДт3", "СтатьяДвиженияДенежныхСредств_Key", "ПодразделениеОрганизации_Key", "ПодразделениеДт_Key", "КассаОрганизации_Key", "ВалютаДокумента_Key", "Контрагент", "Ответственный_Key"],
  Document_ПриходныйКассовыйОрдер: ["ВидОперации", "СтатьяДвиженияДенежныхСредств_Key", "КассаОрганизации_Key", "ВалютаДокумента_Key", "СчетУчетаРасчетовСКонтрагентом_Key", "Ответственный_Key"],
  Document_ОказаниеУслуг: ["ПодразделениеОрганизации_Key", "Номенклатура_Key", "СчетДоходов_Key", "СчетРасходов_Key", "ВалютаДокумента_Key", "Ответственный_Key"],
};
const COUNTED_LAST = 400;
/** The lists that may be long: how many rows, and the first of them whole. */
const SAMPLED = ["Catalog_Контрагенты", "Catalog_ДоговорыКонтрагентов", "Catalog_Номенклатура", "Catalog_Сотрудники", "Catalog_ФизическиеЛица"];
/** Names of documents worth looking at: cash orders, sales, services, entries made by hand. */
const DOCUMENTS = /^Document_(ПриходныйКассовыйОрдер|РасходныйКассовыйОрдер|Реализация[^_]*|АктОбОказании[^_]*|ОказаниеУслуг[^_]*|ОперацияБух|Операция|ПоступлениеНаРасчетныйСчет|СписаниеСРасчетногоСчета)$/;

const short = (value: unknown) => JSON.stringify(value, null, 1).replace(/\n\s*/g, " ");

export async function lookAtOneC(client: OneCClient, say: (line: string) => void): Promise<void> {
  const title = (text: string) => say(`\n=== ${text} ===`);
  const ask = async (what: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      say(`  (не прочитано: ${what}: ${(error as Error).message})`);
    }
  };

  // What the base publishes at all.
  let names: string[] = [];
  title("Что опубликовано в базе");
  await ask("список объектов", async () => {
    const root = (await client.get("/")) as { value?: Array<{ name?: string }> };
    names = (root.value ?? []).map((item) => item.name ?? "").filter(Boolean);
    const count = (prefix: string) => names.filter((name) => name.startsWith(prefix)).length;
    say(`  объектов: ${names.length}; справочников: ${count("Catalog_")}, документов: ${count("Document_")}, регистров накопления: ${count("AccumulationRegister_")}, регистров бухгалтерии: ${count("AccountingRegister_")}`);
    say(`  документы: ${names.filter((name) => name.startsWith("Document_") && !name.includes("_", 9)).join(", ")}`);
    say(`  планы счетов: ${names.filter((name) => name.startsWith("ChartOfAccounts_") && !name.includes("_", 16)).join(", ")}`);
    say(`  регистры бухгалтерии: ${names.filter((name) => name.startsWith("AccountingRegister_") && !name.includes("_", 19)).join(", ")}`);
  });
  const has = (name: string) => names.length === 0 || names.includes(name);
  /** The rows of a list with what every list has of them; a list that is no tree, or has no codes, is asked for less. */
  const anyRows = async (entity: string): Promise<Json[]> => {
    for (const select of ["Ref_Key,Code,Description,IsFolder,DeletionMark", "Ref_Key,Code,Description,DeletionMark", "Ref_Key,Description,DeletionMark"]) {
      try {
        return await client.all(entity, select);
      } catch (error) {
        if (!/не найден/i.test((error as Error).message)) throw error;
      }
    }
    return client.all(entity, "Ref_Key,Description");
  };
  // Every list that has to do with cash desks, whatever this base calls it.
  for (const name of names) if (/^Catalog_[^_]*Касс[^_]*$/.test(name) && !WHOLE.includes(name)) WHOLE.push(name);

  for (const entity of WHOLE) {
    if (!has(entity)) continue;
    title(entity);
    await ask(entity, async () => {
      const rows = await anyRows(entity);
      for (const row of rows) say(`  ${row.DeletionMark ? "(удалён) " : ""}${row.IsFolder ? "[папка] " : ""}${String(row.Code ?? "").trim()} | ${String(row.Description ?? "")} | ${String(row.Ref_Key ?? "")}`);
      if (rows.length === 0) say("  (пусто)");
    });
  }

  for (const entity of SAMPLED) {
    if (!has(entity)) continue;
    title(entity);
    await ask(entity, async () => {
      const rows = await anyRows(entity);
      const live = rows.filter((row) => !row.DeletionMark && !row.IsFolder);
      say(`  строк: ${rows.length}; папок: ${rows.filter((row) => row.IsFolder).length}; помечено на удаление: ${rows.filter((row) => row.DeletionMark).length}`);
      for (const row of rows.filter((item) => item.IsFolder)) say(`  [папка] ${String(row.Code ?? "").trim()} | ${String(row.Description ?? "")} | ${String(row.Ref_Key ?? "")}`);
      say("  первые названия:");
      for (const row of live.slice(0, 40)) say(`    ${String(row.Code ?? "").trim()} | ${String(row.Description ?? "")}`);
      // One row with everything it has: which fields a row of this list is made of.
      const whole = (await client.get(`/${entity}`, { $top: "2", $filter: rows.some((row) => "IsFolder" in row) ? "IsFolder eq false and DeletionMark eq false" : "DeletionMark eq false" })) as { value?: Json[] };
      for (const row of whole.value ?? []) say(`  целиком: ${short(row)}`);
    });
  }

  // The accounts of the chart, by code.
  for (const chart of names.filter((name) => name.startsWith("ChartOfAccounts_") && !name.includes("_", 16))) {
    title(chart);
    await ask(chart, async () => {
      const rows = await client.all(chart, "Ref_Key,Code,Description");
      for (const row of rows.sort((one, other) => String(one.Code).localeCompare(String(other.Code)))) say(`  ${String(row.Code ?? "").trim()} | ${String(row.Description ?? "")} | ${String(row.Ref_Key ?? "")}`);
    });
  }

  // The documents the accountant made: the last few of each kind, whole, and the entries each one made in the books.
  const registers = names.filter((name) => name.startsWith("AccountingRegister_") && name.endsWith("_RecordType"));
  for (const entity of names.filter((name) => DOCUMENTS.test(name))) {
    title(entity);
    await ask(entity, async () => {
      // How many there are and from when to when; and, of the cash orders and the acts, how the last of them are filled in.
      await ask("сколько", async () => {
        const first = (await client.get(`/${entity}`, { $top: "1", $orderby: "Date asc", $select: "Date,Number", $filter: "Posted eq true" })) as { value?: Json[] };
        const count = (await client.get(`/${entity}`, { $top: "1", $select: "Ref_Key", $filter: "Posted eq true", $inlinecount: "allpages" })) as { "odata.count"?: string };
        say(`  проведённых: ${count["odata.count"] ?? "?"}; первый: ${String(first.value?.[0]?.Date ?? "-")} № ${String(first.value?.[0]?.Number ?? "-")}`);
      });
      const fields = COUNTED[entity];
      if (fields) {
        await ask("как заполнены", async () => {
          const recent = (await client.get(`/${entity}`, { $top: String(COUNTED_LAST), $orderby: "Date desc", $filter: "Posted eq true", $select: [...fields, "Комментарий", "Date"].join(",") })) as { value?: Json[] };
          const rows = recent.value ?? [];
          say(`  последние ${rows.length} (с ${String(rows[rows.length - 1]?.Date ?? "-")}): какие значения полей встречаются вместе, сколько раз, и пример комментария`);
          const seen = new Map<string, { count: number; comments: string[] }>();
          for (const row of rows) {
            const key = fields.map((field) => `${field}=${String(row[field] ?? "")}`).filter((part) => !/=(|00000000-0000-0000-0000-000000000000)$/.test(part)).join("; ");
            const known = seen.get(key) ?? { count: 0, comments: [] };
            known.count += 1;
            const comment = String(row["Комментарий"] ?? "").trim();
            if (comment && known.comments.length < 4 && !known.comments.includes(comment)) known.comments.push(comment);
            seen.set(key, known);
          }
          for (const [key, value] of [...seen].sort((one, other) => other[1].count - one[1].count)) say(`    ${value.count} × ${key}  // ${value.comments.join(" | ")}`);
        });
      }
      const last = (await client.get(`/${entity}`, { $top: "3", $orderby: "Date desc", $filter: "Posted eq true" })) as { value?: Json[] };
      const documents = last.value ?? [];
      if (documents.length === 0) say("  (проведённых документов нет)");
      for (const document of documents) {
        say(`  документ: ${short(document)}`);
        for (const register of registers) {
          await ask(`проводки ${register}`, async () => {
            const entries = (await client.get(`/${register}`, { $top: "20", $filter: `Recorder eq cast(guid'${String(document.Ref_Key)}', '${entity}')` })) as { value?: Json[] };
            for (const entry of entries.value ?? []) say(`    проводка: ${short(entry)}`);
          });
        }
      }
    });
  }
  say("\nГотово. В базе ничего не изменено.");
}
