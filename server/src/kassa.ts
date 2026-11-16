import { CURRENCIES, type Currency } from "./money.js";

/** The id of a cash desk, as an entry stores it and the screens send it: "moscow". The city of a person is one too. */
export type Kassa = string;

/** A cash desk of the business: what it is called on the screens, how an entry of it is marked, what money it keeps. */
export type KassaInfo = {
  id: Kassa;
  /** What the screens call it: «Москва». */
  label: string;
  /** Its mark on an entry when the journal shows several desks: «МСК». */
  short: string;
  /** The money it keeps, rubles first. */
  currencies: readonly Currency[];
};

/**
 * The cash desks of one installation, which is one business: its settings name them (`KASSAS`), nothing in the code or
 * in the database does. The first one is the main desk: the desk of a person of everywhere until they choose another.
 */
export type Kassas = {
  readonly list: readonly KassaInfo[];
  readonly ids: readonly Kassa[];
  /** The first desk of the list. */
  readonly primary: Kassa;
  /** Every currency that some desk keeps, rubles first. */
  readonly currencies: readonly Currency[];
  has(id: unknown): id is Kassa;
  /** The currencies of a desk; of every desk, for a desk that is not one of the installation any more (an old entry). */
  currenciesOf(id: Kassa): readonly Currency[];
  /** What a desk is called; its id, for a desk that is not one of the installation any more. */
  labelOf(id: Kassa): string;
  /**
   * Whether a person of `city` works in `kassa`: the city a person has in «Люди» is the cash desk they work in, and a
   * person of everywhere (no city: the admin, the owner) sees every desk. Nobody works in a desk the installation
   * does not have (a person whose city was taken out of the settings: the admin gives them another in «Люди»).
   */
  mayUse(city: Kassa | null, kassa: Kassa): boolean;
  /** The cash desk a person works in when they do not say: their city's, or the main one for a person of everywhere. */
  defaultOf(city: Kassa | null): Kassa;
  /**
   * Whether another desk keeps the same money as this one. Then nothing but its name tells the two apart (a count of
   * dollars only is Andijan's while Moscow keeps rubles too; among three desks of dollars it is anybody's), and what
   * is said of the desk says its name.
   */
  alike(id: Kassa): boolean;
  /** The JSON schema of a desk in a request, and of a city (a desk, or null for everywhere). */
  readonly property: { readonly type: "string"; readonly enum: readonly string[] };
  readonly cityProperty: { readonly type: readonly ["string", "null"]; readonly enum: ReadonlyArray<string | null> };
};

/** The cities whose names the code knows, so that a settings file can stay in plain Latin letters. */
const KNOWN: ReadonlyMap<string, { label: string; short: string }> = new Map([
  ["moscow", { label: "Москва", short: "МСК" }],
  ["andijan", { label: "Андижан", short: "АНД" }],
  ["tashkent", { label: "Ташкент", short: "ТШК" }],
]);

/** What an installation has when its settings do not say: Moscow keeps rubles and dollars, Andijan dollars only. */
export const DEFAULT_KASSAS_SETTING = "moscow:RUB+USD,andijan:USD";

const MAX_KASSAS = 12;
/**
 * Ids that would be taken for something else: the topics of the Telegram group are named by kind and by desk alike
 * (TELEGRAM_THREAD_INCOME), the screens say "both" for every desk at once, and "constructor" is a name every object
 * of the screens already has.
 */
const RESERVED = ["income", "expense", "general", "both", "all", "constructor"];

export function kassasOf(list: readonly KassaInfo[]): Kassas {
  const byId = new Map(list.map((item) => [item.id, item]));
  const ids = list.map((item) => item.id);
  const currencies = CURRENCIES.filter((currency) => list.some((item) => item.currencies.includes(currency)));
  const primary = ids[0]!;
  return {
    list,
    ids,
    primary,
    currencies,
    has: (id: unknown): id is Kassa => typeof id === "string" && byId.has(id),
    currenciesOf: (id) => byId.get(id)?.currencies ?? currencies,
    labelOf: (id) => byId.get(id)?.label ?? KNOWN.get(id)?.label ?? id,
    mayUse: (city, kassa) => byId.has(kassa) && (city === null || city === kassa),
    defaultOf: (city) => city ?? primary,
    alike: (id) => {
      const money = byId.get(id)?.currencies.join();
      return money !== undefined && list.some((item) => item.id !== id && item.currencies.join() === money);
    },
    property: { type: "string", enum: ids },
    cityProperty: { type: ["string", "null"], enum: [...ids, null] },
  };
}

/**
 * Reads the setting `KASSAS`: the desks in their order, each `id:CURRENCY` or `id:CURRENCY+CURRENCY`, separated by
 * commas. A city the code knows (moscow, andijan, tashkent) gets its name by itself; any other is written with its
 * name, `fergana=Фергана:USD`. Without the setting: `moscow:RUB+USD,andijan:USD`.
 *
 *   KASSAS=moscow:USD,andijan:USD,tashkent:USD
 */
export function parseKassas(setting: string | undefined): Kassas {
  const text = setting?.trim() || DEFAULT_KASSAS_SETTING;
  function fail(what: string): never {
    throw new Error(`KASSAS ${what}. It lists the cash desks like moscow:RUB+USD,andijan:USD (a city the code does not know with its name: fergana=Фергана:USD), got "${text}"`);
  }
  const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) fail("names no cash desk");
  if (parts.length > MAX_KASSAS) fail(`names more than ${MAX_KASSAS} cash desks`);

  const list: KassaInfo[] = [];
  for (const part of parts) {
    const found = /^([a-z][a-z0-9_]{0,31})(?:\s*=\s*([^:]+?))?\s*:\s*([A-Za-z+\s]+)$/.exec(part);
    if (!found) fail(`has a part that is not id:CURRENCY, "${part}"`);
    const [, id, name, money] = found as unknown as [string, string, string | undefined, string];
    if (RESERVED.includes(id)) fail(`cannot name a cash desk "${id}"`);
    if (list.some((item) => item.id === id)) fail(`names the cash desk "${id}" twice`);

    const asked = money.split("+").map((code) => code.trim().toUpperCase());
    const unknown = asked.find((code) => !(CURRENCIES as readonly string[]).includes(code));
    if (unknown !== undefined) fail(`gives the cash desk "${id}" the currency "${unknown}", and only ${CURRENCIES.join(" and ")} are kept`);
    if (new Set(asked).size !== asked.length) fail(`gives the cash desk "${id}" a currency twice`);
    const currencies = CURRENCIES.filter((currency) => asked.includes(currency));

    const known = KNOWN.get(id);
    const label = name?.trim() ?? known?.label;
    if (label === undefined) fail(`names the cash desk "${id}", a city the code has no name for: write it as ${id}=Название:${asked.join("+")}`);
    if (label === "" || label.length > 30 || /[\u0000-\u001f]/.test(label)) fail(`gives the cash desk "${id}" a name that is empty or longer than 30 characters`);
    // A settings file saved in a Windows code page: its Russian letters do not survive being read as UTF-8.
    if (label.includes("\uFFFD")) fail(`gives the cash desk "${id}" a name that cannot be read: save the settings file as UTF-8`);
    // The mark of a desk with a name of its own: the first three letters of that name.
    const short = name === undefined && known ? known.short : label.slice(0, 3).toUpperCase();
    list.push({ id, label, short, currencies });
  }
  return kassasOf(list);
}

/** The desks of an installation whose settings do not name any. */
export const DEFAULT_KASSAS = parseKassas(undefined);
