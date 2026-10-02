import type pg from "pg";
import type { Queryable } from "./balances.js";
import { isClientPayment } from "./categories.js";
import { mergeEvents, type LedgerEvents } from "./ledger.js";
import { createOneCClient, OneCError, type Json, type OneCClient, type OneCSettings } from "./onec-api.js";
import {
  clientCodeOf,
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
import type { Outbox } from "./outbox.js";

type Logger = { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

export type OneCOptions = {
  pool: pg.Pool;
  /** The 1C base; undefined when the writing to 1C is off: then nothing is queued. */
  settings: OneCSettings | undefined;
  /** The Telegram group: told when a payment waits for a person or could not be written. */
  telegram: Outbox;
  log: Logger;
  /** The clock of the waits between tries: the real one unless a test moves it. */
  now?: () => Date;
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
  /** Writes a payment of a client to the queue, on the connection (the transaction) of the operation. */
  queue(db: Queryable, operationId: string): Promise<void>;
  nudge(): void;
  flush(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
};

type Row = { id: string; operation_id: string; attempts: number; doc_ref: string | null; doc_number: string | null; alerted: boolean };

type Outcome =
  | { status: "written"; ref: string; number: string; detail: string }
  | { status: "preview"; detail: string }
  | { status: "blocked"; reason: string }
  | { status: "skipped"; reason: string }
  | { status: "retry"; reason: string }
  | { status: "failed"; reason: string };

const money = (minor: number, currency: "RUB" | "USD") => new Intl.NumberFormat("ru-RU", { style: "currency", currency }).format(minor / 100);

/**
 * The queue of payments of clients for 1C. Each becomes one cash receipt "Оплата покупателя" in the base of the
 * company, as the cash books were loaded: found by the code of the client, never made up. A payment that cannot be
 * placed (no such client in 1C, two of them, no contract) waits for a person and the group is told; the base is
 * never changed except by making a new receipt (what is corrected or deleted in the cash desk is not corrected in 1C:
 * the group is told to do it by hand).
 */
export function createOneC(options: OneCOptions): OneC {
  const { pool, settings, telegram, log } = options;
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? 10_000;
  const baseBackoff = options.baseBackoffSeconds ?? 30;
  const blockedRetry = options.blockedRetrySeconds ?? 15 * 60;
  const client: OneCClient | undefined = settings && createOneCClient(settings, options.fetchImpl);

  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let stopped = false;

  const later = (seconds: number) => new Date(now().getTime() + seconds * 1000);

  // What was read of 1C lately.
  let references: { at: number; value: Awaited<ReturnType<typeof readReferences>> } | undefined;
  let counterparts: { at: number; rows: Json[] } | undefined;
  const fresh = (at: number) => Date.now() - at < CATALOG_SECONDS * 1000;
  /** After anything but a success what was read is read again: a person may have just put right what was wrong. */
  const forget = () => {
    references = undefined;
    counterparts = undefined;
  };

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

  async function claim(): Promise<Row | undefined> {
    const claimed = await pool.query<Row>(
      `WITH head AS (
         SELECT id FROM onec_outbox WHERE status IN ('pending', 'blocked') AND next_attempt_at <= $1
          ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       UPDATE onec_outbox o SET attempts = o.attempts + 1, next_attempt_at = $2
         FROM head WHERE o.id = head.id
       RETURNING o.id, o.operation_id, o.attempts, o.doc_ref, o.doc_number, o.alerted`,
      [now(), later(LEASE_SECONDS)],
    );
    return claimed.rows[0];
  }

  /** Works out what to do with one payment, and does it. Never throws: whatever goes wrong is an outcome. */
  async function work(row: Row): Promise<Outcome> {
    const found = await pool.query<{
      kind: "income" | "expense";
      currency: "RUB" | "USD";
      amount_minor: string;
      rate_e4: string | null;
      category: string | null;
      client_code: string | null;
      created_at: Date;
      deleted_at: Date | null;
    }>("SELECT kind, currency, amount_minor, rate_e4, category, client_code, created_at, deleted_at FROM operations WHERE id = $1", [row.operation_id]);
    const operation = found.rows[0];
    if (!operation) return { status: "failed", reason: "операции нет в базе Кассы" };
    if (operation.deleted_at) return { status: "skipped", reason: "приход удалён в Кассе до записи в 1С" };
    if (!isClientPayment(operation.kind, operation.category)) return { status: "skipped", reason: "это уже не оплата от клиента" };

    const code = clientCodeOf(operation.client_code);
    if (!code) return { status: "blocked", reason: `в коде клиента «${operation.client_code ?? ""}» нет кода вида А245` };
    if (settings!.onlyClients && !settings!.onlyClients.includes(code.code)) {
      return { status: "skipped", reason: `клиента ${code.code} нет в списке COSMO_1C_CLIENTS` };
    }
    const dollars = dollarsOf({ currency: operation.currency, amountMinor: Number(operation.amount_minor), rateE4: operation.rate_e4 === null ? null : Number(operation.rate_e4) });
    if (dollars === null) return { status: "blocked", reason: "у прихода в рублях нет курса, не из чего посчитать доллары" };

    try {
      const refs = await referencesNow();
      if ("missing" in refs) return { status: "blocked", reason: refs.missing };
      const picked = pickCounterpart(await counterpartsNow(), code);
      if (!picked.found) return { status: "blocked", reason: picked.reason };
      const contracts = await client!.all("Catalog_ДоговорыКонтрагентов", "Ref_Key,Description,Owner_Key,ВидДоговора,DeletionMark", `Owner_Key eq guid'${picked.counterpart.key}'`);
      const contract = pickContract(contracts, code.code);
      if (!contract) return { status: "blocked", reason: `у контрагента «${picked.counterpart.name}» нет договора` };

      const receipt = { date: documentDate(operation.created_at), dollarsMinor: dollars, comment: code.code };
      const body = receiptBody(settings!, refs.refs, receipt, { counterpart: picked.counterpart, contractKey: contract.key });
      const what = `${money(dollars, "USD")} от «${picked.counterpart.name}» по договору «${contract.name}», дата ${receipt.date}`;
      if (settings!.mode === "preview") return { status: "preview", detail: `репетиция: был бы записан ПКО на ${what}` };

      // A document of this moment, sum and client may be there already: an earlier try made it and was cut off.
      let ref = row.doc_ref;
      let number = row.doc_number;
      let posted = false;
      if (ref === null) {
        const same = (await client!.get(`/${RECEIPT_ENTITY}`, {
          $filter: `Date ge datetime'${receipt.date}' and Date le datetime'${receipt.date}'`,
          $select: "Ref_Key,Number,Posted,СуммаДокумента,Комментарий,КассаОрганизации_Key,DeletionMark",
        })) as { value?: Json[] };
        const twin = (same.value ?? []).find(
          (item) =>
            item.DeletionMark !== true &&
            item["КассаОрганизации_Key"] === settings!.kassaKey &&
            Math.round(Number(item["СуммаДокумента"]) * 100) === dollars &&
            String(item["Комментарий"] ?? "").trim().toLowerCase() === receipt.comment.toLowerCase(),
        );
        if (twin) {
          ref = String(twin.Ref_Key);
          number = String(twin.Number);
          posted = twin.Posted === true;
        }
      } else {
        const known = await client!.get(`/${RECEIPT_ENTITY}(guid'${ref}')`, { $select: "Ref_Key,Number,Posted,DeletionMark" });
        posted = known.Posted === true;
        if (known.DeletionMark === true) return { status: "failed", reason: `документ №${number} в 1С помечен на удаление, запись остановлена` };
      }
      if (ref === null) {
        const made = await client!.create(RECEIPT_ENTITY, body);
        ref = String(made.Ref_Key);
        number = String(made.Number);
      }
      // Kept at once: if the try is cut off from here, the next one goes on with this document.
      await pool.query("UPDATE onec_outbox SET doc_ref = $2, doc_number = $3 WHERE id = $1", [row.id, ref, number]);
      if (!posted) await client!.post(RECEIPT_ENTITY, ref);

      const register = (await client!.get(`/${POSTINGS_ENTITY}(Recorder=guid'${ref}',Recorder_Type='StandardODATA.${RECEIPT_ENTITY}')`)) as { RecordSet?: Json[] };
      if (!postingIsRight(register.RecordSet ?? [], refs.codeOf, dollars)) {
        return { status: "failed", reason: `документ №${number} создан, но проводка не такая, как у оплаты клиента: проверьте его в 1С` };
      }
      return { status: "written", ref, number: number ?? "", detail: `записан ПКО №${number} на ${what}` };
    } catch (error) {
      if (error instanceof OneCError && error.transient) return { status: "retry", reason: error.message };
      return { status: "failed", reason: error instanceof OneCError ? error.message : "непредвиденная ошибка при записи в 1С" };
    }
  }

  async function finish(row: Row, outcome: Outcome): Promise<void> {
    if (outcome.status === "blocked" || outcome.status === "failed" || outcome.status === "retry") forget();
    const alert = async (text: string) => {
      if (row.alerted) return;
      await telegram.queue(pool, text, row.operation_id, "income");
      await pool.query("UPDATE onec_outbox SET alerted = true WHERE id = $1", [row.id]);
      telegram.nudge();
    };
    const label = async () => {
      const found = await pool.query<{ client_code: string | null; currency: "RUB" | "USD"; amount_minor: string }>(
        "SELECT client_code, currency, amount_minor FROM operations WHERE id = $1",
        [row.operation_id],
      );
      const operation = found.rows[0];
      return operation ? `${operation.client_code ?? ""} ${money(Number(operation.amount_minor), operation.currency)}`.trim() : row.operation_id;
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
      case "preview":
        await pool.query("UPDATE onec_outbox SET status = 'preview', detail = $2 WHERE id = $1", [row.id, outcome.detail]);
        return;
      case "skipped":
        await pool.query("UPDATE onec_outbox SET status = 'skipped', detail = $2 WHERE id = $1", [row.id, outcome.reason]);
        return;
      case "blocked":
        await pool.query("UPDATE onec_outbox SET status = 'blocked', detail = $2, next_attempt_at = $3 WHERE id = $1", [row.id, outcome.reason, later(blockedRetry)]);
        await alert(`⚠️ Приход ${await label()} не записан в 1С: ${outcome.reason}.\nКогда это будет исправлено в 1С, запись повторится сама (раз в 15 минут). Если приход в 1С не нужен: kassa.ps1 onec-skip --id ${row.id}`);
        return;
      case "failed":
        await pool.query("UPDATE onec_outbox SET status = 'failed', detail = $2 WHERE id = $1", [row.id, outcome.reason]);
        log.error(`The payment ${row.operation_id} was not written to 1C: ${outcome.reason}`);
        await alert(`❌ Приход ${await label()} не записан в 1С: ${outcome.reason}.\nЧто с ним делать, решает человек: kassa.ps1 onec-status, затем onec-retry --id ${row.id} или onec-skip --id ${row.id}`);
        return;
      case "retry": {
        if (row.attempts >= MAX_ATTEMPTS) {
          await finish(row, { status: "failed", reason: `1С не отвечает уже ${row.attempts} попыток: ${outcome.reason}` });
          return;
        }
        const wait = Math.min(MAX_BACKOFF_SECONDS, baseBackoff * 2 ** (row.attempts - 1));
        log.warn(`The payment ${row.operation_id} was not written to 1C (try ${row.attempts}), the next try in ${wait} s: ${outcome.reason}`);
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
    async queue(db, operationId) {
      if (!settings) return;
      await db.query("INSERT INTO onec_outbox (operation_id, created_at, next_attempt_at) VALUES ($1, $2, $2) ON CONFLICT (operation_id) DO NOTHING", [operationId, now()]);
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
 * The events of the operations for 1C: a payment of a client is queued when it is entered. What is done to it after it
 * is in 1C is not done to the document: the group is told to correct or delete it there by hand.
 */
export function onecEvents(onec: OneC, telegram: Outbox): LedgerEvents | undefined {
  if (!onec.enabled) return undefined;
  return {
    async created(db, row) {
      if (isClientPayment(row.kind, row.category)) await onec.queue(db, row.id);
    },
    async changed(db, event) {
      const state = (await db.query<{ status: string; doc_number: string | null }>("SELECT status, doc_number FROM onec_outbox WHERE operation_id = $1", [event.row.id])).rows[0];
      // Until it is written the payment is worked out afresh at each try, so a correction or a deletion reaches 1C by itself.
      if (!state || state.status !== "written") return;
      const what = `${event.before.clientCode ?? ""} ${money(event.before.amountMinor, event.before.currency)}`.trim();
      await telegram.queue(
        db,
        event.action === "delete"
          ? `⚠️ Приход ${what} удалён в Кассе, а в 1С уже записан документ ПКО №${state.doc_number}. Касса 1С не меняет: распровести и пометить его на удаление нужно в 1С вручную.`
          : `⚠️ Приход ${what} исправлен в Кассе, а в 1С уже записан документ ПКО №${state.doc_number}. Касса 1С не меняет: исправьте документ в 1С вручную.`,
        event.row.id,
        "income",
      );
    },
  };
}

export { mergeEvents };
