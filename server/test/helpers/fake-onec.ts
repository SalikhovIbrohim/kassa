import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

type Json = Record<string, unknown>;

export const KEYS = {
  organization: "bf358780-5b3f-11f1-8cb6-b8cb29f61f4c",
  kassa: "0d2cb474-924a-11f1-8cb7-b8cb29f61f4c",
  currency: "542c581a-49bf-11ef-afed-8c1d965e9add",
};
const ACCOUNTS = { "5010": "acc-5010", "4010": "acc-4010", "6310": "acc-6310", "9430": "acc-9430" } as const;
const PAYMENT_ITEM = "dds-payment-from-buyers";

export type FakeOneC = {
  url: string;
  user: string;
  password: string;
  counterparts: Json[];
  contracts: Json[];
  /** The receipts in the base. */
  documents: Json[];
  /** The requests that came, "METHOD /path" with the path decoded, in order. */
  requests: string[];
  /** The next `times` requests whose "METHOD /path" holds `match` are answered with this status. */
  failNext(match: string, status: number, times?: number): void;
  /** The next request that holds `match` is carried out, and the answer is never given: the connection is cut. */
  loseAnswerOf(match: string): void;
  /** What the next posting does: the entries are not those of a payment of a client. */
  postWrongly(): void;
  /** Puts right the entries of every posted document, as a person would in 1C. */
  fixPostings(): void;
  addClient(code: string, name: string): { counterpart: string; contract: string };
  close(): Promise<void>;
};

export async function startFakeOneC(): Promise<FakeOneC> {
  const user = "robot";
  const password = "s3cret";
  let failures: Array<{ match: string; status: number }> = [];
  let lost: string[] = [];
  let wrong = false;
  const postings = new Map<string, Json[]>();
  let numbers = 1790;

  const fake: FakeOneC = {
    url: "",
    user,
    password,
    counterparts: [],
    contracts: [],
    documents: [],
    requests: [],
    failNext(match, status, times = 1) {
      failures = [...failures, ...Array.from({ length: times }, () => ({ match, status }))];
    },
    loseAnswerOf(match) {
      lost.push(match);
    },
    postWrongly() {
      wrong = true;
    },
    fixPostings() {
      for (const rows of postings.values()) for (const row of rows) row.AccountCr_Key = ACCOUNTS["6310"];
    },
    addClient(code, name) {
      const counterpart = randomUUID();
      const contract = randomUUID();
      fake.counterparts.push({ Ref_Key: counterpart, Description: `${code} ${name}`, ИНН: "", DeletionMark: false, IsFolder: false });
      fake.contracts.push({ Ref_Key: contract, Description: `№${code} от 01.01.2026`, Owner_Key: counterpart, ВидДоговора: "СПокупателем", DeletionMark: false });
      return { counterpart, contract };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://fake");
      const path = decodeURIComponent(url.pathname).replace(/^\/odata\/standard\.odata/, "");
      const line = `${request.method} ${path}`;
      fake.requests.push(line);
      const answer = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.headers.authorization !== "Basic " + Buffer.from(`${user}:${password}`).toString("base64")) return answer(401, {});

      const failure = failures.find((item) => line.includes(item.match));
      if (failure) {
        failures.splice(failures.indexOf(failure), 1);
        return answer(failure.status, { "odata.error": { message: { value: `fake refusal ${failure.status}` } } });
      }
      const page = (rows: Json[]) => {
        const top = Number(url.searchParams.get("$top") ?? rows.length);
        const skip = Number(url.searchParams.get("$skip") ?? 0);
        return answer(200, { value: rows.slice(skip, skip + top) });
      };

      if (request.method === "GET" && path === "/ChartOfAccounts_Хозрасчетный") {
        return page(Object.entries(ACCOUNTS).map(([Code, Ref_Key]) => ({ Ref_Key, Code })));
      }
      if (request.method === "GET" && path === "/Catalog_СтатьиДвиженияДенежныхСредств") {
        return page([
          { Ref_Key: PAYMENT_ITEM, Description: "Оплата от покупателей", DeletionMark: false },
          { Ref_Key: "dds-old", Description: "Оплата от покупателей", DeletionMark: true },
        ]);
      }
      const thing = /^\/Catalog_(Организации|КассыОрганизаций|Валюты)\(guid'([^']+)'\)$/.exec(path);
      if (thing && request.method === "GET") {
        const known: Record<string, string> = { [KEYS.organization]: "Космо", [KEYS.kassa]: "Москва", [KEYS.currency]: "Доллар" };
        const found = known[thing[2]!];
        return found ? answer(200, { Ref_Key: thing[2], Description: found }) : answer(404, { "odata.error": { message: { value: "Not Found" } } });
      }
      if (request.method === "GET" && path === "/Catalog_Контрагенты") return page(fake.counterparts);
      if (request.method === "GET" && path === "/Catalog_ДоговорыКонтрагентов") {
        const owner = /Owner_Key eq guid'([^']+)'/.exec(url.searchParams.get("$filter") ?? "")?.[1];
        return page(fake.contracts.filter((row) => row.Owner_Key === owner));
      }
      if (request.method === "GET" && path === "/Document_ПриходныйКассовыйОрдер") {
        const at = /Date ge datetime'([^']+)'/.exec(url.searchParams.get("$filter") ?? "")?.[1];
        return page(fake.documents.filter((row) => row.Date === at));
      }
      const one = /^\/Document_ПриходныйКассовыйОрдер\(guid'([^']+)'\)(\/Post)?$/.exec(path);
      if (one && request.method === "GET") {
        const found = fake.documents.find((row) => row.Ref_Key === one[1]);
        return found ? answer(200, found) : answer(404, {});
      }
      if (request.method === "POST" && path === "/Document_ПриходныйКассовыйОрдер") {
        const body = JSON.parse(raw) as Json;
        const document = { ...body, Ref_Key: randomUUID(), Number: `0000-C0${++numbers}`, Posted: false, DeletionMark: false };
        fake.documents.push(document);
        if (lost.some((match) => line.includes(match))) {
          lost = lost.filter((match) => !line.includes(match));
          return request.socket.destroy();
        }
        return answer(201, document);
      }
      if (one && one[2] && request.method === "POST") {
        const document = fake.documents.find((row) => row.Ref_Key === one[1]);
        if (!document) return answer(404, {});
        document.Posted = true;
        const sum = Number(document["СуммаДокумента"]);
        postings.set(String(document.Ref_Key), [{ AccountDr_Key: ACCOUNTS["5010"], AccountCr_Key: wrong ? ACCOUNTS["9430"] : ACCOUNTS["6310"], Сумма: sum }]);
        wrong = false;
        if (lost.some((match) => line.includes(match))) {
          lost = lost.filter((match) => !line.includes(match));
          return request.socket.destroy();
        }
        return answer(200, {});
      }
      const register = /^\/AccountingRegister_Хозрасчетный\(Recorder=guid'([^']+)',Recorder_Type='[^']+'\)$/.exec(path);
      if (register && request.method === "GET") return answer(200, { RecordSet: postings.get(register[1]!) ?? [] });
      return answer(404, { "odata.error": { message: { value: "Not Found" } } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The fake 1C did not bind to a port");
  fake.url = `http://127.0.0.1:${address.port}`;
  return fake;
}
