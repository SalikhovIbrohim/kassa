/** The 1C base the payments of clients are written into (the settings of the OData service). */
export type OneCSettings = {
  /** The address of the OData service, with or without the trailing `/odata/standard.odata`. */
  url: string;
  user: string;
  password: string;
  /** The organization, the cash desk and the currency of the documents, by their keys in the base. */
  organizationKey: string;
  kassaKey: string;
  currencyKey: string;
  /** `preview` only looks and says what would be written; `live` writes. */
  mode: "preview" | "live";
  /** When set, only the payments of these clients (codes like А339) are written; the others are left alone. */
  onlyClients?: string[];
};

/**
 * 1C did not do what was asked. `transient` says that trying again may work (the connection broke, the server is
 * busy or failed inside): 1C is known to drop connections. A refusal with a 4xx answer is not transient: the request
 * itself is wrong.
 */
export class OneCError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OneCError";
  }
}

type Fetch = typeof fetch;
export type Json = Record<string, unknown>;

const SUFFIX = "/odata/standard.odata";

/** What 1C said was wrong, from its error body. Never holds the address or the login. */
function errorText(body: string): string {
  try {
    const error = (JSON.parse(body) as { "odata.error"?: { message?: { value?: string } | string } })["odata.error"];
    const message = error?.message;
    return (typeof message === "string" ? message : message?.value) ?? body.slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}

export type OneCClient = ReturnType<typeof createOneCClient>;

/** A small client of the OData service of 1C: what the scripts of the cash books do, with the connection drops in mind. */
export function createOneCClient(settings: Pick<OneCSettings, "url" | "user" | "password">, fetchImpl: Fetch = fetch) {
  const base = settings.url.replace(/\/+$/, "");
  const root = base.endsWith(SUFFIX) ? base : base + SUFFIX;
  const authorization = "Basic " + Buffer.from(`${settings.user}:${settings.password}`, "utf8").toString("base64");

  async function request(method: "GET" | "POST", path: string, query?: string, body?: unknown): Promise<{ status: number; text: string }> {
    // The path holds Russian names and a guid in quotes: percent-encode what needs it, leave what OData itself uses.
    const url = `${root}${encodeURI(path)}${query ? `?${query}` : ""}`;
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          authorization,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      return { status: response.status, text: await response.text() };
    } catch (error) {
      // Not the error itself: the address in it is nobody else's business.
      const reason = (error as { name?: string }).name === "TimeoutError" ? "no answer in time" : "no connection";
      throw new OneCError(`1C cannot be reached (${reason})`, true);
    }
  }

  function check(status: number, text: string, what: string): void {
    if (status >= 200 && status < 300) return;
    throw new OneCError(`1C refused ${what} (HTTP ${status}): ${errorText(text)}`, status >= 500 || status === 408 || status === 429, status);
  }

  /** `$filter` and the like: the value is percent-encoded, the name keeps its dollar. */
  const queryOf = (parts: Record<string, string>) =>
    Object.entries(parts)
      .map(([name, value]) => `${name}=${encodeURIComponent(value).replace(/%27/g, "'")}`)
      .join("&");

  return {
    async get(path: string, parts: Record<string, string> = {}): Promise<Json> {
      const { status, text } = await request("GET", path, queryOf({ $format: "json", ...parts }));
      check(status, text, `to read ${path.split("(")[0]}`);
      return JSON.parse(text) as Json;
    },

    /** Every row of a catalog, 500 at a time. */
    async all(entity: string, select: string, filter?: string): Promise<Json[]> {
      const rows: Json[] = [];
      for (let skip = 0; ; skip += 500) {
        const page = (await this.get(`/${entity}`, { $top: "500", $skip: String(skip), $select: select, ...(filter ? { $filter: filter } : {}) })) as { value?: Json[] };
        const chunk = page.value ?? [];
        rows.push(...chunk);
        if (chunk.length < 500) return rows;
      }
    },

    /** Creates a document and returns what 1C answered (its key and number). */
    async create(entity: string, body: unknown): Promise<Json> {
      const { status, text } = await request("POST", `/${entity}`, queryOf({ $format: "json" }), body);
      check(status, text, `to create a document of ${entity}`);
      return JSON.parse(text) as Json;
    },

    /** Posts a document (проведение). */
    async post(entity: string, ref: string): Promise<void> {
      const { status, text } = await request("POST", `/${entity}(guid'${ref}')/Post`, "PostingModeOperational=false");
      check(status, text, "to post the document");
    },
  };
}
