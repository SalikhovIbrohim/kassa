import { createSign } from "node:crypto";

/** Where the journal is copied to: a Google spreadsheet, written by a service account of Google Cloud. */
export type SheetSettings = {
  /** The service account: its address (the spreadsheet is shared with it as an editor) and its private key. */
  clientEmail: string;
  privateKey: string;
  /** Where the service account gets its access token; from its key file. */
  tokenUrl: string;
  /** The spreadsheet: the long id in its address, between /d/ and /edit. */
  spreadsheetId: string;
  /** The sheet (tab) of the spreadsheet the journal goes to; made if it is not there. */
  tab: string;
  /** Only the entries made from this instant on are copied (the start of a day of the cash desk); undefined: all. */
  from: Date | undefined;
  /** The address of the Sheets API; only a test sets another one. */
  apiUrl: string;
};

/** A failure of Google: `status` is the HTTP status, 0 when Google could not be reached. */
export class SheetsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TIMEOUT_MS = 20_000;

const base64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** The settings read from the key file of the service account (JSON, as Google gives it to download). */
export function readServiceAccountKey(text: string): { clientEmail: string; privateKey: string; tokenUrl: string } {
  let key: { client_email?: unknown; private_key?: unknown; token_uri?: unknown };
  try {
    key = JSON.parse(text) as typeof key;
  } catch {
    throw new Error("The key file of the Google service account is not JSON: download it again (Keys, Add key, JSON)");
  }
  if (typeof key.client_email !== "string" || typeof key.private_key !== "string") {
    throw new Error("The key file of the Google service account has no client_email or private_key: is it the key of a service account?");
  }
  return {
    clientEmail: key.client_email,
    privateKey: key.private_key,
    tokenUrl: typeof key.token_uri === "string" ? key.token_uri : "https://oauth2.googleapis.com/token",
  };
}

/** The few calls of the Sheets API the copy of the journal needs, with the access token kept until it runs out. */
export function createSheetsClient(settings: SheetSettings, fetchImpl: typeof fetch = fetch) {
  let token: { value: string; until: number } | undefined;

  async function call(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new SheetsError(`Google could not be reached: ${(error as Error).message}`, 0);
    }
    const text = await response.text();
    if (!response.ok) {
      // Google says what is wrong in error.message; never more than that, and never the token.
      let said = text.slice(0, 300);
      try {
        const body = JSON.parse(text) as { error?: { message?: string } | string; error_description?: string };
        said = body.error_description ?? (typeof body.error === "object" ? body.error.message : body.error) ?? said;
      } catch {
        // not JSON: the start of the text will do
      }
      throw new SheetsError(`Google answered ${response.status}: ${said}`, response.status);
    }
    return text ? (JSON.parse(text) as unknown) : {};
  }

  async function accessToken(): Promise<string> {
    if (token && Date.now() < token.until) return token.value;
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
      JSON.stringify({ iss: settings.clientEmail, scope: SCOPE, aud: settings.tokenUrl, iat: now, exp: now + 3600 }),
    )}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(settings.privateKey);
    const answer = (await call(settings.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${base64url(signature)}` }),
    })) as { access_token?: string; expires_in?: number };
    if (!answer.access_token) throw new SheetsError("Google gave no access token", 500);
    token = { value: answer.access_token, until: Date.now() + Math.max(60, (answer.expires_in ?? 3600) - 120) * 1000 };
    return token.value;
  }

  const sheetUrl = (path: string) => `${settings.apiUrl}/v4/spreadsheets/${encodeURIComponent(settings.spreadsheetId)}${path}`;
  /** A range of the tab, like A1:N1; the name of the tab is quoted, as it may have spaces or not be Latin. */
  const range = (cells: string) => encodeURIComponent(`'${settings.tab.replace(/'/g, "''")}'!${cells}`);
  const authorized = async (init: RequestInit = {}): Promise<RequestInit> => ({
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
  });

  return {
    /** Makes the tab when the spreadsheet does not have it yet. */
    async ensureTab(): Promise<void> {
      const found = (await call(sheetUrl("?fields=sheets.properties.title"), await authorized())) as { sheets?: Array<{ properties?: { title?: string } }> };
      if (found.sheets?.some((sheet) => sheet.properties?.title === settings.tab)) return;
      await call(sheetUrl(":batchUpdate"), await authorized({ method: "POST", body: JSON.stringify({ requests: [{ addSheet: { properties: { title: settings.tab } } }] }) }));
    },

    /** The values of a range, row by row (empty rows at the end are left out by Google). */
    async read(cells: string): Promise<unknown[][]> {
      const answer = (await call(sheetUrl(`/values/${range(cells)}`), await authorized())) as { values?: unknown[][] };
      return answer.values ?? [];
    },

    /** Writes the rows from the first cell of `cells` on, as they are (no formulas, no guessing of dates). */
    async write(cells: string, rows: unknown[][]): Promise<void> {
      await call(sheetUrl(`/values/${range(cells)}?valueInputOption=RAW`), await authorized({ method: "PUT", body: JSON.stringify({ values: rows }) }));
    },

    /** Adds a row under the last one; returns its number. */
    async append(row: unknown[]): Promise<number> {
      const answer = (await call(
        sheetUrl(`/values/${range("A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`),
        await authorized({ method: "POST", body: JSON.stringify({ values: [row] }) }),
      )) as { updates?: { updatedRange?: string } };
      const number = /![A-Z]+(\d+)/.exec(answer.updates?.updatedRange ?? "")?.[1];
      if (!number) throw new SheetsError(`Google did not say where the row went (${answer.updates?.updatedRange ?? "nothing"})`, 500);
      return Number(number);
    },
  };
}

export type SheetsClient = ReturnType<typeof createSheetsClient>;
