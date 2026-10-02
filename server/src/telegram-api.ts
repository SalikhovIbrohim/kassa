/** Where the messages go: the bot, the group (its number, negative), and the address of the Bot API. */
export type TelegramSettings = {
  botToken: string;
  groupChatId: string;
  /** `https://api.telegram.org` unless a test or a proxy stands in for it. */
  apiUrl: string;
};

/**
 * Telegram did not take a message. `permanent` says that trying again will not help (the chat does not exist, the bot
 * was removed from the group, the token is wrong); otherwise the network, Telegram or the rate limit is to blame, and
 * the message waits and is sent again. The text never holds the token: the address of a request carries it.
 */
export class TelegramError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    /** What Telegram asked to wait, in seconds, when it said so. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

type Fetch = typeof fetch;

type BotApiAnswer = {
  ok?: boolean;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
  result?: unknown;
};

/** Asks the Bot API something and returns `result`, or throws a `TelegramError`. */
async function call(settings: TelegramSettings, method: string, body: unknown, fetchImpl: Fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(`${settings.apiUrl}/bot${settings.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    // Not the error itself: the address in it holds the token.
    const reason = (error as { name?: string }).name === "TimeoutError" ? "no answer in time" : "no connection";
    throw new TelegramError(`Telegram cannot be reached (${reason})`, false);
  }
  const answer = (await response.json().catch(() => null)) as BotApiAnswer | null;
  if (response.ok && answer?.ok) return answer.result;

  const status = answer?.error_code ?? response.status;
  const said = answer?.description ?? `HTTP ${response.status}`;
  // 400, 401, 403 and 404 say that the request itself is wrong (no such chat, the bot was thrown out, a bad token).
  const permanent = [400, 401, 403, 404].includes(status);
  throw new TelegramError(`Telegram refused (${status}): ${said}`, permanent, answer?.parameters?.retry_after);
}

/** Sends a message to the group. */
export async function sendToGroup(settings: TelegramSettings, text: string, fetchImpl: Fetch = fetch): Promise<void> {
  await call(settings, "sendMessage", { chat_id: settings.groupChatId, text, disable_web_page_preview: true }, fetchImpl);
}

export type SeenChat = { id: number; title: string; type: string };

/**
 * The chats the bot has been told about lately (it was added to a group, somebody wrote to it): how the number of
 * the group is found. Telegram keeps updates for a day.
 */
export async function seenChats(settings: Omit<TelegramSettings, "groupChatId">, fetchImpl: Fetch = fetch): Promise<SeenChat[]> {
  const updates = (await call({ ...settings, groupChatId: "" }, "getUpdates", { limit: 100, timeout: 0 }, fetchImpl)) as Array<
    Record<string, { chat?: { id?: number; title?: string; first_name?: string; username?: string; type?: string } } | undefined>
  >;
  const found = new Map<number, SeenChat>();
  for (const update of updates) {
    for (const part of [update.message, update.channel_post, update.my_chat_member, update.edited_message]) {
      const chat = part?.chat;
      if (chat?.id === undefined || !chat.type) continue;
      found.set(chat.id, { id: chat.id, type: chat.type, title: chat.title ?? chat.first_name ?? chat.username ?? "" });
    }
  }
  return [...found.values()];
}
