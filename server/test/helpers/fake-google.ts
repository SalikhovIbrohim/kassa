import { createVerify, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { SheetSettings } from "../../src/sheets-api.js";

/**
 * A Google of our own for the tests: it hands out tokens to a service account whose key it made (and checks the
 * signature), and keeps spreadsheets in memory, so that the copy of the journal is seen at work without Google.
 */
export type FakeGoogle = {
  url: string;
  /** Settings of a service account and a spreadsheet of this fake; `overrides` changes any of them. */
  settings(overrides?: Partial<SheetSettings>): SheetSettings;
  /** The cells of a tab, row by row (row 1 first); undefined when there is no such tab. */
  tab(name: string): string[][] | undefined;
  /** Refuse the next requests to the spreadsheet (not the token) with this status, `times` times. */
  failNext(status: number, times?: number): void;
  /** Takes back the refusals not used yet. */
  clearFailures(): void;
  /** How many rows were appended. */
  appends: number;
  /** Waits until the tab has `count` rows. */
  untilRows(name: string, count: number): Promise<string[][]>;
  close(): Promise<void>;
};

const SPREADSHEET = "1FakeSpreadsheetIdForTheTests_abcdefgh";
const EMAIL = "kassa@kassa-test.iam.gserviceaccount.com";

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const tabs = new Map<string, string[][]>([["Лист1", []]]);
  const tokens = new Set<string>();
  let failures: number[] = [];

  const fake: FakeGoogle = {
    url: "",
    settings: (overrides = {}) => ({
      clientEmail: EMAIL,
      privateKey: pem,
      tokenUrl: `${fake.url}/token`,
      spreadsheetId: SPREADSHEET,
      tab: "Журнал",
      from: undefined,
      apiUrl: fake.url,
      ...overrides,
    }),
    tab: (name) => tabs.get(name),
    failNext(status, times = 1) {
      failures = [...failures, ...Array.from({ length: times }, () => status)];
    },
    clearFailures() {
      failures = [];
    },
    appends: 0,
    async untilRows(name, count) {
      for (let attempt = 0; attempt < 200 && (tabs.get(name)?.length ?? 0) < count; attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
      return tabs.get(name) ?? [];
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  /** "'Журнал'!A5:N5" -> the tab, the first row and the first column (0 = A). */
  const parseRange = (text: string) => {
    const [, quoted, plain, column, row] = /^(?:'((?:[^']|'')+)'|([^!]+))!([A-Z]+)(\d*)/.exec(text) ?? [];
    return { tab: (quoted ?? plain ?? "").replace(/''/g, "'"), column: column ? column.charCodeAt(0) - 65 : 0, row: row ? Number(row) : undefined };
  };

  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const answer = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      const url = new URL(request.url ?? "/", "http://fake");

      if (url.pathname === "/token") {
        const assertion = new URLSearchParams(raw).get("assertion") ?? "";
        const [header, claims, signature] = assertion.split(".");
        const valid = createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature ?? "", "base64url"));
        const claim = JSON.parse(Buffer.from(claims ?? "", "base64url").toString() || "{}") as { iss?: string; scope?: string };
        if (!valid || claim.iss !== EMAIL || !claim.scope?.includes("spreadsheets")) return answer(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
        const token = `token-${tokens.size + 1}`;
        tokens.add(token);
        return answer(200, { access_token: token, expires_in: 3600, token_type: "Bearer" });
      }

      if (!tokens.has((request.headers.authorization ?? "").replace(/^Bearer /, ""))) return answer(401, { error: { code: 401, message: "Request had invalid authentication credentials." } });
      const failure = failures.shift();
      if (failure) return answer(failure, { error: { code: failure, message: `fake refusal ${failure}` } });

      const match = /^\/v4\/spreadsheets\/([^/:]+)(.*)$/.exec(url.pathname);
      if (!match || decodeURIComponent(match[1]!) !== SPREADSHEET) return answer(404, { error: { code: 404, message: "Requested entity was not found." } });
      const rest = match[2]!;

      if (rest === "" && request.method === "GET") return answer(200, { sheets: [...tabs.keys()].map((title) => ({ properties: { title } })) });
      if (rest === ":batchUpdate") {
        const body = JSON.parse(raw) as { requests: Array<{ addSheet?: { properties: { title: string } } }> };
        for (const item of body.requests) if (item.addSheet) tabs.set(item.addSheet.properties.title, []);
        return answer(200, {});
      }
      const values = /^\/values\/([^:]+)(:append)?$/.exec(rest);
      if (!values) return answer(404, { error: { code: 404, message: "no such call" } });
      const range = parseRange(decodeURIComponent(values[1]!));
      const grid = tabs.get(range.tab);
      if (!grid) return answer(400, { error: { code: 400, message: `Unable to parse range: ${range.tab}` } });

      if (values[2]) {
        const row = (JSON.parse(raw) as { values: string[][] }).values[0]!;
        grid.push(row.map(String));
        fake.appends++;
        return answer(200, { updates: { updatedRange: `'${range.tab}'!A${grid.length}:N${grid.length}` } });
      }
      if (request.method === "GET") {
        const rows = grid.slice((range.row ?? 1) - 1, range.row === undefined ? undefined : range.row);
        return answer(200, { values: rows.map((cells) => cells.slice(range.column)) });
      }
      if (request.method === "PUT") {
        const rows = (JSON.parse(raw) as { values: unknown[][] }).values;
        rows.forEach((cells, index) => {
          const at = (range.row ?? 1) - 1 + index;
          while (grid.length <= at) grid.push([]);
          grid[at] = cells.map(String);
        });
        return answer(200, {});
      }
      return answer(405, { error: { code: 405, message: "no" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  fake.url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return fake;
}
