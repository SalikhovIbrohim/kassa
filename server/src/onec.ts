import type pg from "pg";
import type { Queryable } from "./balances.js";
import { cashDayEnd, cashDayOf } from "./cash-day.js";
import { isClientPayment } from "./categories.js";
import type { Kassa } from "./kassa.js";
import { mergeEvents, type LedgerEvents } from "./ledger.js";
import { createOneCClient, OneCError, type Json, type OneCClient, type OneCSettings } from "./onec-api.js";
import {
  clientCodeOf,
  CONTRACT_ENTITY,
  contractBody,
  COUNTERPART_ENTITY,
  counterpartBody,
  type ClientCode,
  documentDate,
  dollarsOf,
  pickContract,
  pickCounterpart,
  postingIsRight,
  POSTINGS_ENTITY,
  readReferences,
  receiptBody,
  RECEIPT_ENTITY,
  type References,
} from "./onec-pko.js";
import { departmentOf, DEPARTMENT_ENTITY, EXPENSE_ACCOUNTS, EXPENSE_ENTITY, EXPENSE_FIELDS, expenseBody, expensePostingIsRight, placeExpense, readExpenseLists } from "./onec-rko.js";
import { lineCents, readServiceReferences, sameService, SERVICE_ENTITY, serviceBody, servicePostingIsRight, type ServiceLine } from "./onec-services.js";
import type { Outbox } from "./outbox.js";

type Logger = { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

export type OneCOptions = {
  pool: pg.Pool;
  /** The 1C base; undefined when the writing to 1C is off: then nothing is queued. */
  settings: OneCSettings | undefined;
  /** The Telegram group: told when a payment waits for a person or could not be written. */
  telegram: Outbox;
  /** The cash desks whose payments of clients are written to 1C (the main desk of the installation, unless the settings name others). */
  kassas: readonly Kassa[];
  /** The main cash desk of the installation. */
  primaryKassa: Kassa;
  /** What a cash desk is called («Москва»): the other expenses of the base are kept by city. */
  kassaLabel?: (kassa: Kassa) => string;
  /** How the business writes the codes of its clients: «А245» unless said. */
  clientCodes?: "letter" | "digits";
  log: Logger;
  /** The clock of the waits between tries: the real one unless a test moves it. */
  now?: () => Date;
  /** The clock of the days of the cash desk, which says when the night comes (the app's: a test sets it). */
  today?: () => Date;
  fetchImpl?: typeof fetch;
  /** How often the worker looks for what is due. */
  intervalMs?: number;
  /** The first wait after 1C could not be reached, in seconds; it doubles up to a quarter of an hour. */
  baseBackoffSeconds?: number;
  /** How long a payment that waits for a person waits for the next look, in seconds. */
  blockedRetrySeconds?: number;
};

/** 1C that cannot be reached for this many tries in a row (about nine hours) is given up on: a person has to look. */
const MAX_ATTEMPTS = 40;
const MAX_BACKOFF_SECONDS = 15 * 60;
/** A payment that is being written is not offered to anybody else for this long. */
const LEASE_SECONDS = 180;
/** What is read of the catalogs is kept this long: they are big, and change by hand. */
const CATALOG_SECONDS = 60;

export type OneC = {
  readonly enabled: boolean;
  readonly mode: "preview" | "live" | undefined;
  /** Whether the payments of clients of this cash desk are written to 1C. */
  writes(kassa: Kassa): boolean;
  /** Whether an entry is one that goes to 1C: a payment of a client, and what else the settings name (`documents`). */
  wants(db: Queryable, entry: { kind: "income" | "expense"; category: string | null; client_code: string | null; created_at: Date }): Promise<boolean>;
  /** Writes a payment of a client to the queue, on the connection (the transaction) of the operation. */
  queue(db: Queryable, operationId: string): Promise<void>;
  /** When what was entered or changed now goes to 1C: at once, or at the end of the day of the cash desk (03:00 Moscow time). */
  due(): Date;
  /**
   * A trip was changed (on the connection of the change): one that has arrived is queued, at once, and the document
   * of one that is in the base already follows what was done to the trip. Nothing where the settings name no trips.
   */
  tripChanged(db: Queryable, tripId: string): Promise<void>;
  nudge(): void;
  flush(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
};

type Row = { id: string; operation_id: string; trip_id: string | null; attempts: number; doc_ref: string | null; doc_number: string | null; alerted: boolean; removed_by_kassa: boolean };

type Outcome =
  | { status: "written"; ref: string; number: string; detail: string }
  | { status: "removed"; detail: string }
  | { status: "preview"; detail: string }
  | { status: "blocked"; reason: string }
  | { status: "skipped"; reason: string }
  | { status: "retry"; reason: string }
  | { status: "failed"; reason: string };

/** Whether the document in 1C says what the payment says now: the moment, the sum, the client, the contract, the code. */
function sameDocument(known: Json, body: Json): boolean {
  const day = (value: unknown) => String(value ?? "").slice(0, 19);
  const cents = (value: unknown) => Math.round(Number(value) * 100);
  return (
    day(known.Date) === day(body.Date) &&
    cents(known["СуммаДокумента"]) === cents(body["СуммаДокумента"]) &&
    String(known["Контрагент"] ?? "") === String(body["Контрагент"] ?? "") &&
    String(known["ДоговорКонтрагента_Key"] ?? "") === String(body["ДоговорКонтрагента_Key"] ?? "") &&
    String(known["Комментарий"] ?? "").trim().toLowerCase() === String(body["Комментарий"] ?? "").trim().toLowerCase()
  );
}

const money = (minor: number, currency: "RUB" | "USD") => new Intl.NumberFormat("ru-RU", { style: "currency", currency }).format(minor / 100);

/**
 * The queue of payments of clients for 1C. Each becomes one cash receipt "Оплата покупателя" in the base of the
 * company, as the cash books were loaded: found by the code of the client, never made up. A payment that cannot be
 * placed (no such client in 1C, two of them, no contract) waits for a person and the group is told. What is done to
 * the payment in the cash desk is done to its document: a correction changes it and posts it again, a deletion
 * unposts it and marks it for deletion (never deletes it outright: the accountant empties what is marked).
 */
export function createOneC(options: OneCOptions): OneC {
  const { pool, settings, telegram, log } = options;
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? 10_000;
  const baseBackoff = options.baseBackoffSeconds ?? 30;
  const blockedRetry = options.blockedRetrySeconds ?? 15 * 60;
  const client: OneCClient | undefined = settings && createOneCClient(settings, options.fetchImpl);
  const writing = new Set(options.kassas);
  const clientCodes = options.clientCodes ?? "letter";
  /** The cash desk in the base that the payments of a cash desk go to. */
  const kassaKeyOf = (kassa: Kassa) => {
    const own = settings!.kassaKeys;
    return own && Object.hasOwn(own, kassa) ? own[kassa]! : settings!.kassaKey;
  };

  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let stopped = false;

  const later = (seconds: number) => new Date(now().getTime() + seconds * 1000);
  // Sent at night: the day is over, the cashier's corrections are in, and the average rate of the day is final.
  const today = options.today ?? now;
  const due = () => (settings?.send === "night" ? cashDayEnd(cashDayOf(today())) : now());

  // What was read of 1C lately.
  let references: { at: number; value: Awaited<ReturnType<typeof readReferences>> } | undefined;
  let counterparts: { at: number; rows: Json[] } | undefined;
  const fresh = (at: number) => Date.now() - at < CATALOG_SECONDS * 1000;
  /** After anything but a success what was read is read again: a person may have just put right what was wrong. */
  const forget = () => {
    references = undefined;
    counterparts = undefined;
    expenseLists = undefined;
  };
  let expenseLists: { at: number; value: Awaited<ReturnType<typeof readExpenseLists>> } | undefined;
  async function expenseListsNow() {
    if (!expenseLists || !fresh(expenseLists.at)) expenseLists = { at: Date.now(), value: await readExpenseLists(client!) };
    return expenseLists.value;
  }

  const documents = new Set(settings?.documents ?? []);
  /** Whether an entry is of before the first day that goes to the base: those were put there by hand. */
  const early = (at: Date) => settings?.from !== undefined && cashDayOf(at) < settings.from;
  /**
   * What goes to 1C. A payment of a client always. Where the settings say `incomes`, any income of a category that
   * names a client (money a client gave in another city is a payment all the same); where they say `expenses`, every
   * expense.
   */
  const wanted = (entry: { kind: "income" | "expense"; category: string | null; client_code: string | null; requires_client: boolean | null }) =>
    entry.kind === "expense"
      ? documents.has("expenses")
      : isClientPayment(entry.kind, entry.category) || (documents.has("incomes") && entry.requires_client === true && (entry.client_code ?? "").trim() !== "");

  async function referencesNow() {
    if (!references || !fresh(references.at)) references = { at: Date.now(), value: await readReferences(client!) };
    return references.value;
  }
  async function counterpartsNow() {
    if (!counterparts || !fresh(counterparts.at)) {
      counterparts = { at: Date.now(), rows: await client!.all("Catalog_Контрагенты", "Ref_Key,Description,ИНН,DeletionMark,IsFolder") };
    }
    return counterparts.rows;
  }

  /**
   * The counterpart and the contract of a client in the base. Where the settings say so, a client the base does not
   * have is made there with a contract, as its own clients are (and a contract alone, for a counterpart without one):
   * by the name the directory of the cash desk has. In the rehearsal nothing is made: it is said what would be.
   */
  async function counterpartOf(
    code: ClientCode,
  ): Promise<{ picked: { found: true; counterpart: { key: string; name: string } }; contract: { key: string; name: string } } | { reason: string } | { wouldMake: string }> {
    const make = settings!.createClients === true;
    let picked = pickCounterpart(await counterpartsNow(), code, clientCodes);
    if (!picked.found) {
      if (!picked.none || !make) return { reason: picked.reason };
      const known = await pool.query<{ name: string }>("SELECT name FROM clients WHERE code = $1", [code.code]);
      const name = known.rows[0]?.name.trim();
      if (!name) return { reason: `${picked.reason}, и в справочнике Кассы нет клиента с таким кодом: создать некого` };
      const body = counterpartBody({ code: code.code, name }, await countryNow());
      if (settings!.mode === "preview") return { wouldMake: `контрагент «${String(body.Description)}» с договором` };
      const made = await client!.create(COUNTERPART_ENTITY, body);
      counterparts = undefined;
      picked = { found: true, counterpart: { key: String(made.Ref_Key), name: String(made.Description ?? body.Description) } };
    }
    const contracts = await client!.all(CONTRACT_ENTITY, "Ref_Key,Description,Owner_Key,ВидДоговора,DeletionMark", `Owner_Key eq guid'${picked.counterpart.key}'`);
    let contract = pickContract(contracts, code.code);
    if (!contract) {
      if (!make) return { reason: `у контрагента «${picked.counterpart.name}» нет договора` };
      if (settings!.mode === "preview") return { wouldMake: `договор контрагента «${picked.counterpart.name}»` };
      const body = contractBody(settings!, picked.counterpart.key, code.code, Number(cashDayOf(today()).slice(0, 4)));
      const made = await client!.create(CONTRACT_ENTITY, body);
      contract = { key: String(made.Ref_Key), name: String(made.Description ?? body.Description) };
    }
    return { picked, contract };
  }

  /** The country the clients of the base are of: the one most of them have (a new client is made the same). */
  let country: string | undefined | null = null;
  async function countryNow(): Promise<string | undefined> {
    if (country !== null) return country;
    const some = (await client!.get(`/${COUNTERPART_ENTITY}`, { $top: "50", $select: "СтранаРегистрации_Key", $filter: "DeletionMark eq false" }).catch(() => ({ value: [] }))) as { value?: Json[] };
    const counts = new Map<string, number>();
    for (const row of some.value ?? []) {
      const key = String(row["СтранаРегистрации_Key"] ?? "");
      if (key && key !== "00000000-0000-0000-0000-000000000000") counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    country = [...counts].sort((one, other) => other[1] - one[1])[0]?.[0];
    return country;
  }

  async function claim(): Promise<Row | undefined> {
    const claimed = await pool.query<Row>(
      `WITH head AS (
         SELECT id FROM onec_outbox WHERE status IN ('pending', 'blocked') AND next_attempt_at <= $1
          ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       UPDATE onec_outbox o SET attempts = o.attempts + 1, next_attempt_at = $2
         FROM head WHERE o.id = head.id
       RETURNING o.id, o.operation_id, o.trip_id, o.attempts, o.doc_ref, o.doc_number, o.alerted, o.removed_by_kassa`,
      [now(), later(LEASE_SECONDS)],
    );
    return claimed.rows[0];
  }

  type Operation = {
    kind: "income" | "expense";
    currency: "RUB" | "USD";
    amount_minor: string;
    rate_e4: string | null;
    category: string | null;
    client_code: string | null;
    trip_number: number | null;
    recipient: string | null;
    comment: string | null;
    created_at: Date;
    deleted_at: Date | null;
    kassa: Kassa;
    label: string | null;
    requires_client: boolean | null;
    counts_as_cost: boolean | null;
  };

  /** A document to be in the base, and how to tell that it is there and right. */
  type Plan = {
    entity: string;
    /** «ПКО», «РКО»: what the people call the document. */
    noun: string;
    body: Json;
    /** What it is, in words, for the journal. */
    what: string;
    kassaKey: string;
    dollars: number;
    comment: string;
    /** The document of an earlier try that was cut off, found another way than by the moment, the sum and the comment. */
    twin?: () => Promise<Json | undefined>;
    /** Whether a document says what the plan says, told another way than field by field. */
    same?: (known: Json) => boolean;
    /** The fields, besides the moment, the sum and the comment, that the document must agree with the body in. */
    fields: readonly string[];
    postingIsRight(rows: readonly Json[], codeOf: ReadonlyMap<string, string>): boolean;
    /** What the postings should have been, for the one who has to look. */
    expected: string;
  };

  /** Whether the document in 1C says what the entry says now. */
  const samePlan = (known: Json, plan: Plan) => (plan.same ? plan.same(known) : sameDocument(known, plan.body) && plan.fields.every((field) => String(known[field] ?? "") === String(plan.body[field] ?? "")));

  /** Works out what to do with one entry, and does it. Never throws: whatever goes wrong is an outcome. */
  async function work(row: Row): Promise<Outcome> {
    if (row.trip_id !== null) return workTrip(row);
    const found = await pool.query<Operation>(
      `SELECT o.kind, o.currency, o.amount_minor, o.rate_e4, o.category, o.client_code, o.trip_number, o.recipient, o.comment, o.created_at, o.deleted_at, o.kassa,
              c.label, c.requires_client, c.counts_as_cost
         FROM operations o LEFT JOIN categories c ON c.code = o.category
        WHERE o.id = $1`,
      [row.operation_id],
    );
    const operation = found.rows[0];
    if (!operation) return { status: "failed", reason: "операции нет в базе Кассы" };
    const entity = operation.kind === "income" ? RECEIPT_ENTITY : EXPENSE_ENTITY;
    const noun = operation.kind === "income" ? "ПКО" : "РКО";
    const entry = operation.kind === "income" ? "приход" : "расход";
    if (early(operation.created_at) && row.doc_ref === null) return { status: "skipped", reason: `запись до ${settings!.from}: в 1С с этого дня (ONEC_FROM)` };
    if (operation.deleted_at || !wanted(operation)) {
      const why = operation.deleted_at ? `${entry} удалён в Кассе` : operation.kind === "income" ? "это уже не оплата от клиента" : "расходы в 1С не записываются";
      if (row.doc_ref === null) return { status: "skipped", reason: operation.deleted_at ? `${entry} удалён в Кассе до записи в 1С` : why };
      return remove(row, why, entity, noun);
    }

    // The desk of the entry was taken out of the desks that go to 1C since it was queued: nothing of it is written,
    // and a document it has already is not moved to the cash desk of another desk. A person looks at that one.
    if (!writing.has(operation.kassa)) {
      const why = `${operation.kind === "income" ? "приходы" : "расходы"} кассы ${operation.kassa} в 1С не записываются (ONEC_KASSAS)`;
      return row.doc_ref === null ? { status: "skipped", reason: why } : { status: "failed", reason: `${why}, а документ №${row.doc_number} уже есть: проверьте его в 1С` };
    }
    const dollars = dollarsOf({ currency: operation.currency, amountMinor: Number(operation.amount_minor), rateE4: operation.rate_e4 === null ? null : Number(operation.rate_e4) });

    try {
      const plan = operation.kind === "income" ? await receiptPlan(operation, dollars) : await expensePlan(operation, dollars);
      if ("status" in plan) return plan;
      if (settings!.mode === "preview") return { status: "preview", detail: `репетиция: был бы записан ${noun} на ${plan.what}` };
      return await write(row, plan);
    } catch (error) {
      return trouble(error);
    }
  }

  /** A trip that has arrived, as the services rendered to its clients; a trip that is not arrived any more takes its document back. */
  async function workTrip(row: Row): Promise<Outcome> {
    const found = await pool.query<{ number: number; status: string; arrival_day: string | null; driver_name: string | null; driver_phone: string | null; truck_plates: string | null; deleted_at: Date | null }>(
      "SELECT number, status, to_char(arrival_day, 'YYYY-MM-DD') AS arrival_day, driver_name, driver_phone, truck_plates, deleted_at FROM trips WHERE id = $1",
      [row.trip_id],
    );
    const trip = found.rows[0];
    if (!trip) return { status: "failed", reason: "рейса нет в базе Кассы" };
    const noun = "«Оказание услуг»";
    const cargo = await pool.query<{ client_code: string; weight_g: string; price_milli: number; bags: number | null; pieces: number | null; brand: string | null; sender: string | null; receiver: string | null; item: string | null; size: string | null }>(
      "SELECT client_code, weight_g, price_milli, bags, pieces, brand, sender, receiver, item, size FROM trip_cargo WHERE trip_id = $1 AND deleted_at IS NULL ORDER BY position",
      [row.trip_id],
    );
    const gone = trip.deleted_at !== null || trip.status !== "arrived" || trip.arrival_day === null ? "рейс уже не «прибыл»" : cargo.rows.length === 0 ? "в накладной рейса нет строк" : undefined;
    if (gone) return row.doc_ref === null ? { status: "skipped", reason: gone } : remove(row, gone, SERVICE_ENTITY, noun);

    try {
      const read = await readServiceReferences(client!);
      if ("missing" in read) return { status: "blocked", reason: read.missing };
      const lists = await expenseListsNow();
      if ("missing" in lists) return { status: "blocked", reason: lists.missing };
      // Who owes for each line, in the base: a client it does not have is made where the settings say so.
      const would: string[] = [];
      const placed = new Map<string, { counterpart: string; contract: string }>();
      for (const code of new Set(cargo.rows.map((line) => line.client_code))) {
        const who = await counterpartOf({ code, name: "" });
        if ("reason" in who) return { status: "blocked", reason: who.reason };
        if ("wouldMake" in who) would.push(who.wouldMake);
        else placed.set(code, { counterpart: who.picked.counterpart.key, contract: who.contract.key });
      }
      let department = departmentOf(lists.lists, trip.number)?.key;
      if (!department && settings!.mode === "preview") would.push(`подразделение «${trip.number}»`);
      const total = cargo.rows.reduce((sum, line) => sum + lineCents({ weightG: Number(line.weight_g), priceMilli: line.price_milli }), 0);
      const what = `по рейсу ${trip.number}: строк ${cargo.rows.length}, клиентов ${new Set(cargo.rows.map((line) => line.client_code)).size}, на ${money(total, "USD")}, дата ${trip.arrival_day}`;
      if (settings!.mode === "preview") return { status: "preview", detail: `репетиция: был бы записан документ ${noun} ${what}${would.length > 0 ? `; были бы созданы: ${would.join(", ")}` : ""}` };
      department ??= await makeDepartment(trip.number);

      const lines: ServiceLine[] = cargo.rows.map((line) => ({ ...placed.get(line.client_code)!, weightG: Number(line.weight_g), priceMilli: line.price_milli, bags: line.bags, pieces: line.pieces, brand: line.brand, sender: line.sender, receiver: line.receiver, item: line.item, size: line.size }));
      const body = serviceBody(settings!, read.refs, { number: trip.number, arrivalDay: trip.arrival_day!, driverName: trip.driver_name, driverPhone: trip.driver_phone, truckPlates: trip.truck_plates }, department, lines);
      const own = department;
      return await write(row, {
        entity: SERVICE_ENTITY,
        noun,
        body,
        what,
        kassaKey: "",
        dollars: total,
        comment: String(body["Комментарий"]),
        // One document to a trip: the one that is on the department of the trip already is this one.
        twin: async () => {
          const there = (await client!.get(`/${SERVICE_ENTITY}`, { $filter: `ПодразделениеОрганизации_Key eq guid'${own}' and DeletionMark eq false` })) as { value?: Json[] };
          return there.value?.[0];
        },
        same: (known) => sameService(known, body),
        fields: [],
        postingIsRight: (rows) => servicePostingIsRight(rows, read.codeOf, total),
        expected: "как у оказания услуг (Кт 9030.1 на сумму рейса)",
      });
    } catch (error) {
      return trouble(error);
    }
  }

  /** The cash receipt of a payment of a client, or why there is none yet. */
  async function receiptPlan(operation: Operation, dollars: number | null): Promise<Plan | Outcome> {
    const code = clientCodeOf(operation.client_code, clientCodes);
    if (!code) return { status: "blocked", reason: `в коде клиента «${operation.client_code ?? ""}» нет кода вида ${clientCodes === "digits" ? "245" : "А245"}` };
    if (settings!.onlyClients && !settings!.onlyClients.includes(code.code)) {
      return { status: "skipped", reason: `клиента ${code.code} нет в списке ONEC_CLIENTS` };
    }
    if (dollars === null) return { status: "blocked", reason: "у прихода в рублях нет курса, не из чего посчитать доллары" };
    const refs = await referencesNow();
    if ("missing" in refs) return { status: "blocked", reason: refs.missing };
    const placed = await counterpartOf(code);
    if ("reason" in placed) return { status: "blocked", reason: placed.reason };
    if ("wouldMake" in placed) return { status: "preview", detail: `репетиция: был бы создан ${placed.wouldMake} и записан ПКО на ${money(dollars, "USD")}, дата ${documentDate(operation.created_at)}` };
    const { picked, contract } = placed;

    const receipt = { date: documentDate(operation.created_at), dollarsMinor: dollars, comment: code.code };
    const kassaKey = kassaKeyOf(operation.kassa);
    return {
      entity: RECEIPT_ENTITY,
      noun: "ПКО",
      body: receiptBody({ ...settings!, kassaKey }, refs.refs, receipt, { counterpart: picked.counterpart, contractKey: contract.key }),
      what: `${money(dollars, "USD")} от «${picked.counterpart.name}» по договору «${contract.name}», дата ${receipt.date}`,
      kassaKey,
      dollars,
      comment: receipt.comment,
      fields: [],
      postingIsRight: (rows, codeOf) => postingIsRight(rows, codeOf, dollars),
      expected: "как у оплаты клиента",
    };
  }

  /** The expense order of an expense of the cash desk, or why there is none yet. */
  async function expensePlan(operation: Operation, dollars: number | null): Promise<Plan | Outcome> {
    // Money handed to the owner and money given back to a client are documents of their own kinds: a person writes those.
    if (operation.counts_as_cost === false) return { status: "skipped", reason: "выплата владельцу записывается в 1С вручную" };
    if (operation.requires_client) return { status: "skipped", reason: "возврат клиенту записывается в 1С вручную" };
    if (dollars === null) return { status: "blocked", reason: "у расхода в рублях нет курса, не из чего посчитать доллары" };
    const refs = await referencesNow();
    if ("missing" in refs) return { status: "blocked", reason: refs.missing };
    const read = await expenseListsNow();
    if ("missing" in read) return { status: "blocked", reason: read.missing };
    const label = operation.label ?? operation.category ?? "Прочее";
    const placement = placeExpense(read.lists, { label, tripNumber: operation.trip_number, kassaName: options.kassaLabel?.(operation.kassa) ?? operation.kassa });
    if ("reason" in placement) return { status: "blocked", reason: placement.reason };

    const date = documentDate(operation.created_at);
    const comment = [label, placement.account === "production" ? `рейс ${placement.trip}` : operation.trip_number !== null ? `рейс ${operation.trip_number}` : "", operation.comment?.trim() ?? ""].filter(Boolean).join(" ").slice(0, 200);
    const what = `${money(dollars, "USD")}, ${placement.words}, дата ${date}`;
    // The department of the trip: made in the base when the first cost of the trip is written, as the accountant does.
    let department: string | undefined;
    if (placement.account === "production") {
      department = departmentOf(read.lists, placement.trip)?.key;
      if (!department) {
        if (settings!.mode === "preview") return { status: "preview", detail: `репетиция: было бы создано подразделение «${placement.trip}» и записан РКО на ${what}` };
        department = await makeDepartment(placement.trip);
      }
    }
    const kassaKey = kassaKeyOf(operation.kassa);
    return {
      entity: EXPENSE_ENTITY,
      noun: "РКО",
      body: expenseBody({ ...settings!, kassaKey }, read.lists, { date, dollarsMinor: dollars, comment, recipient: operation.recipient?.trim() ?? "" }, placement, department),
      what,
      kassaKey,
      dollars,
      comment,
      fields: EXPENSE_FIELDS,
      postingIsRight: (rows, codeOf) => expensePostingIsRight(rows, codeOf, placement, dollars),
      expected: `как должна быть (Дт ${EXPENSE_ACCOUNTS[placement.account]} Кт ${EXPENSE_ACCOUNTS.cash})`,
    };
  }

  /** Makes the department of a trip, as the departments of the other trips are: under what they are under. */
  async function makeDepartment(trip: number): Promise<string> {
    const like = (await client!.get(`/${DEPARTMENT_ENTITY}`, { $top: "1", $filter: "DeletionMark eq false", $orderby: "Code desc" })) as { value?: Json[] };
    const sample = like.value?.[0] ?? {};
    const body: Json = { Description: String(trip) };
    for (const field of ["Owner_Key", "Parent_Key"]) if (typeof sample[field] === "string") body[field] = sample[field];
    const made = await client!.create(DEPARTMENT_ENTITY, body);
    expenseLists = undefined;
    return String(made.Ref_Key);
  }

  /** Puts the document of a plan into the base: finds the one an earlier try made, corrects the one that differs, posts, checks. */
  async function write(row: Row, plan: Plan): Promise<Outcome> {
    const { entity, noun, body } = plan;
    const refs = await referencesNow();
    if ("missing" in refs) return { status: "blocked", reason: refs.missing };
    const date = String(body.Date);
    // A document of this moment, sum and comment may be there already: an earlier try made it and was cut off.
    let ref = row.doc_ref;
    let number = row.doc_number;
    let posted = false;
    let corrected = false;
    if (ref === null && plan.twin) {
      const twin = await plan.twin();
      if (twin) {
        ref = String(twin.Ref_Key);
        number = String(twin.Number);
        posted = twin.Posted === true;
        if (!samePlan(twin, plan)) {
          if (posted) await client!.unpost(entity, ref);
          await client!.update(entity, ref, body);
          posted = false;
          corrected = true;
        }
      }
    } else if (ref === null) {
      const same = (await client!.get(`/${entity}`, {
        $filter: `Date ge datetime'${date}' and Date le datetime'${date}'`,
        $select: "Ref_Key,Number,Posted,СуммаДокумента,Комментарий,КассаОрганизации_Key,DeletionMark",
      })) as { value?: Json[] };
      const twin = (same.value ?? []).find(
        (item) =>
          item.DeletionMark !== true &&
          item["КассаОрганизации_Key"] === plan.kassaKey &&
          Math.round(Number(item["СуммаДокумента"]) * 100) === plan.dollars &&
          String(item["Комментарий"] ?? "").trim().toLowerCase() === plan.comment.toLowerCase(),
      );
      if (twin) {
        ref = String(twin.Ref_Key);
        number = String(twin.Number);
        posted = twin.Posted === true;
      }
    } else {
      // A document that is compared line by line is read whole.
      const known = await client!.get(
        `/${entity}(guid'${ref}')`,
        plan.same ? {} : { $select: ["Ref_Key,Number,Posted,DeletionMark,Date,СуммаДокумента,Контрагент,ДоговорКонтрагента_Key,Комментарий", ...plan.fields].join(",") },
      );
      posted = known.Posted === true;
      // A mark a person put stops the cash desk; its own mark (the entry was deleted or was not for 1C for a while) it takes off.
      const unmark = known.DeletionMark === true && row.removed_by_kassa;
      if (known.DeletionMark === true && !unmark) return { status: "failed", reason: `документ №${number} в 1С помечен на удаление, запись остановлена` };
      // The entry was corrected in the cash desk since the document was made: the document is corrected the same way.
      if (unmark || !samePlan(known, plan)) {
        if (posted) await client!.unpost(entity, ref);
        await client!.update(entity, ref, unmark ? { ...body, DeletionMark: false } : body);
        if (unmark) await pool.query("UPDATE onec_outbox SET removed_by_kassa = false WHERE id = $1", [row.id]);
        posted = false;
        corrected = true;
      }
    }
    if (ref === null) {
      const made = await client!.create(entity, body);
      ref = String(made.Ref_Key);
      number = String(made.Number);
    }
    // Kept at once: if the try is cut off from here, the next one goes on with this document.
    await pool.query("UPDATE onec_outbox SET doc_ref = $2, doc_number = $3 WHERE id = $1", [row.id, ref, number]);
    if (!posted) await client!.post(entity, ref);

    const register = (await client!.get(`/${POSTINGS_ENTITY}(Recorder=guid'${ref}',Recorder_Type='StandardODATA.${entity}')`)) as { RecordSet?: Json[] };
    if (!plan.postingIsRight(register.RecordSet ?? [], refs.codeOf)) {
      return { status: "failed", reason: `документ №${number} создан, но проводка не такая, ${plan.expected}: проверьте его в 1С` };
    }
    return { status: "written", ref, number: number ?? "", detail: `${corrected ? "исправлен" : "записан"} ${noun} №${number} на ${plan.what}` };
  }

  /** What went wrong with 1C, as an outcome: tried again when 1C could not be reached, given up when it refused. */
  function trouble(error: unknown): Outcome {
    if (error instanceof OneCError && error.transient) return { status: "retry", reason: error.message };
    return { status: "failed", reason: error instanceof OneCError ? error.message : "непредвиденная ошибка при записи в 1С" };
  }

  /** The payment is gone from the cash desk (or is no payment of a client any more): its document is unposted and marked for deletion. */
  async function remove(row: Row, why: string, entity: string, noun: string): Promise<Outcome> {
    const ref = row.doc_ref!;
    if (settings!.mode === "preview") return { status: "preview", detail: `репетиция: документ ${noun} №${row.doc_number} был бы распроведён и помечен на удаление (${why})` };
    try {
      let known: Json;
      try {
        known = await client!.get(`/${entity}(guid'${ref}')`, { $select: "Ref_Key,Number,Posted,DeletionMark" });
      } catch (error) {
        // Deleted in 1C already, by a person: nothing is left to do.
        if (error instanceof OneCError && error.status === 404) return { status: "removed", detail: `документа ${noun} №${row.doc_number} в 1С уже нет: ${why}` };
        throw error;
      }
      if (known.Posted === true) await client!.unpost(entity, ref);
      if (known.DeletionMark !== true) {
        await client!.update(entity, ref, { DeletionMark: true });
        await pool.query("UPDATE onec_outbox SET removed_by_kassa = true WHERE id = $1", [row.id]);
      }
      return { status: "removed", detail: `документ ${noun} №${row.doc_number} распроведён и помечен на удаление: ${why}` };
    } catch (error) {
      return trouble(error);
    }
  }

  async function finish(row: Row, outcome: Outcome): Promise<void> {
    if (outcome.status === "blocked" || outcome.status === "failed" || outcome.status === "retry") forget();
    const alert = async (text: string) => {
      if (row.alerted) return;
      if (row.trip_id !== null) {
        await telegram.queue(pool, text, null, { kind: "expense", kassa: options.primaryKassa });
        await pool.query("UPDATE onec_outbox SET alerted = true WHERE id = $1", [row.id]);
        telegram.nudge();
        return;
      }
      // Told where the incomes of the cash desk of the payment are told.
      const desk = await pool.query<{ kassa: Kassa; kind: "income" | "expense" }>("SELECT kassa, kind FROM operations WHERE id = $1", [row.operation_id]);
      await telegram.queue(pool, text, row.operation_id, { kind: desk.rows[0]?.kind ?? "income", kassa: desk.rows[0]?.kassa ?? options.primaryKassa });
      await pool.query("UPDATE onec_outbox SET alerted = true WHERE id = $1", [row.id]);
      telegram.nudge();
    };
    const label = async () => {
      if (row.trip_id !== null) {
        const trip = await pool.query<{ number: number }>("SELECT number FROM trips WHERE id = $1", [row.trip_id]);
        return `Рейс ${trip.rows[0]?.number ?? "?"}`;
      }
      const found = await pool.query<{ kind: "income" | "expense"; client_code: string | null; currency: "RUB" | "USD"; amount_minor: string; label: string | null }>(
        "SELECT o.kind, o.client_code, o.currency, o.amount_minor, c.label FROM operations o LEFT JOIN categories c ON c.code = o.category WHERE o.id = $1",
        [row.operation_id],
      );
      const operation = found.rows[0];
      if (!operation) return `Приход ${row.operation_id}`;
      const sum = money(Number(operation.amount_minor), operation.currency);
      return operation.kind === "income" ? `Приход ${`${operation.client_code ?? ""} ${sum}`.trim()}` : `Расход «${operation.label ?? ""}» ${sum}`;
    };

    switch (outcome.status) {
      case "written":
        await pool.query("UPDATE onec_outbox SET status = 'written', written_at = $2, doc_ref = $3, doc_number = $4, detail = $5 WHERE id = $1", [
          row.id,
          now(),
          outcome.ref,
          outcome.number,
          outcome.detail,
        ]);
        return;
      case "removed":
        await pool.query("UPDATE onec_outbox SET status = 'removed', detail = $2 WHERE id = $1", [row.id, outcome.detail]);
        return;
      case "preview":
        await pool.query("UPDATE onec_outbox SET status = 'preview', detail = $2 WHERE id = $1", [row.id, outcome.detail]);
        return;
      case "skipped":
        await pool.query("UPDATE onec_outbox SET status = 'skipped', detail = $2 WHERE id = $1", [row.id, outcome.reason]);
        return;
      case "blocked":
        await pool.query("UPDATE onec_outbox SET status = 'blocked', detail = $2, next_attempt_at = $3 WHERE id = $1", [row.id, outcome.reason, later(blockedRetry)]);
        await alert(`⚠️ ${await label()} не записан в 1С: ${outcome.reason}.\nКогда это будет исправлено в 1С, запись повторится сама (раз в 15 минут). Если запись в 1С не нужна: kassa.ps1 onec-skip --id ${row.id}`);
        return;
      case "failed":
        await pool.query("UPDATE onec_outbox SET status = 'failed', detail = $2 WHERE id = $1", [row.id, outcome.reason]);
        log.error(`The ${row.trip_id !== null ? `trip ${row.trip_id}` : `payment ${row.operation_id}`} was not written to 1C: ${outcome.reason}`);
        await alert(`❌ ${await label()} не записан в 1С: ${outcome.reason}.\nЧто с ним делать, решает человек: kassa.ps1 onec-status, затем onec-retry --id ${row.id} или onec-skip --id ${row.id}`);
        return;
      case "retry": {
        if (row.attempts >= MAX_ATTEMPTS) {
          await finish(row, { status: "failed", reason: `1С не отвечает уже ${row.attempts} попыток: ${outcome.reason}` });
          return;
        }
        const wait = Math.min(MAX_BACKOFF_SECONDS, baseBackoff * 2 ** (row.attempts - 1));
        log.warn(`The ${row.trip_id !== null ? `trip ${row.trip_id}` : `payment ${row.operation_id}`} was not written to 1C (try ${row.attempts}), the next try in ${wait} s: ${outcome.reason}`);
        await pool.query("UPDATE onec_outbox SET detail = $2, next_attempt_at = $3 WHERE id = $1", [row.id, outcome.reason, later(wait)]);
      }
    }
  }

  async function flushNow(): Promise<void> {
    while (!stopped) {
      const row = await claim();
      if (!row) return;
      await finish(row, await work(row));
    }
  }

  function flush(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await flushNow().catch((error: unknown) => log.error(`The queue of 1C could not be worked through: ${(error as Error).message}`));
        } while (again && !stopped);
      } finally {
        running = undefined;
      }
    })();
    return running;
  }

  return {
    enabled: settings !== undefined,
    mode: settings?.mode,
    writes: (kassa) => settings !== undefined && writing.has(kassa),
    async wants(db, entry) {
      if (!settings || early(entry.created_at)) return false;
      if (entry.kind === "income" && isClientPayment(entry.kind, entry.category)) return true;
      if (documents.size === 0 || entry.category === null) return false;
      const category = await db.query<{ requires_client: boolean }>("SELECT requires_client FROM categories WHERE code = $1", [entry.category]);
      return wanted({ ...entry, requires_client: category.rows[0]?.requires_client ?? null });
    },
    async queue(db, operationId) {
      if (!settings) return;
      await db.query("INSERT INTO onec_outbox (operation_id, created_at, next_attempt_at) VALUES ($1, $2, $3) ON CONFLICT (operation_id) DO NOTHING", [operationId, now(), due()]);
    },
    due,
    async tripChanged(db, tripId) {
      if (!settings || !documents.has("trips")) return;
      // The document of a trip is written at once: the trip was closed by a person who looked at its waybill.
      const again = await db.query(
        `UPDATE onec_outbox SET status = 'pending', attempts = 0, alerted = false, next_attempt_at = $2, written_at = NULL, detail = NULL
          WHERE trip_id = $1 AND NOT (status = 'skipped' AND detail LIKE 'пропущен вручную%')`,
        [tripId, now()],
      );
      if (again.rowCount) return;
      await db.query(
        `INSERT INTO onec_outbox (trip_id, created_at, next_attempt_at)
         SELECT t.id, $2, $2 FROM trips t
          WHERE t.id = $1 AND t.status = 'arrived' AND t.deleted_at IS NULL AND NOT t.from_card_file AND ($3::date IS NULL OR t.arrival_day >= $3::date)
         ON CONFLICT (trip_id) DO NOTHING`,
        [tripId, now(), settings.from ?? null],
      );
    },
    nudge() {
      if (!settings || stopped) return;
      setImmediate(() => void flush());
    },
    flush,
    start() {
      if (!settings || timer) return;
      timer = setInterval(() => void flush(), intervalMs);
      timer.unref();
      void flush();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}

/**
 * The events of the operations for 1C: a payment of a client is queued when it is entered, and again whenever it is
 * corrected or deleted, so that its document follows (see `remove` and the correction in `work`). A payment the admin
 * gave up on («Не записывать») stays given up.
 */
export function onecEvents(onec: OneC): LedgerEvents | undefined {
  if (!onec.enabled) return undefined;
  return {
    async created(db, row) {
      // Only the cash desks that keep their book in 1C: the main one (Moscow), unless the settings name others.
      if (onec.writes(row.kassa) && (await onec.wants(db, row))) await onec.queue(db, row.id);
    },
    async changed(db, event) {
      const again = await db.query(
        `UPDATE onec_outbox SET status = 'pending', attempts = 0, alerted = false, next_attempt_at = $2, written_at = NULL, detail = NULL
          WHERE operation_id = $1 AND NOT (status = 'skipped' AND detail LIKE 'пропущен вручную%')`,
        [event.row.id, onec.due()],
      );
      if (again.rowCount) return;
      // Not in the queue yet: an income that became a payment of a client by the correction.
      const known = await db.query("SELECT 1 FROM onec_outbox WHERE operation_id = $1", [event.row.id]);
      if (known.rowCount === 0 && event.action === "edit" && onec.writes(event.row.kassa) && (await onec.wants(db, event.row))) {
        await onec.queue(db, event.row.id);
      }
    },
  };
}

export { mergeEvents };
