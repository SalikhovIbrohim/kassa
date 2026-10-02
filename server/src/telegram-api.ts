/** Where the messages go: the bot, the group (its number, negative), and the address of the Bot API. */
export type TelegramSettings = {
  botToken: string;
  groupChatId: string;
  /** The topics of the group that get the messages about incomes and about expenses, when the group has topics; without one the main topic ("General") gets them. */
  incomeThreadId?: number;
  expenseThreadId?: number;
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

/** Sends a message to the group, into a topic of it if one is named. */
export async function sendToGroup(settings: TelegramSettings, text: string, threadId?: number, fetchImpl: Fetch = fetch): Promise<void> {
  await call(
    settings,
    "sendMessage",
    {
      chat_id: settings.groupChatId,
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
      text,
      disable_web_page_preview: true,
    },
    fetchImpl,
  );
}

export type SeenChat = {
  id: number;
  title: string;
  type: string;
  /** The topics of a group with topics that a message was seen in: the number to put in TELEGRAM_GROUP_THREAD_ID, and what the topic is called when that was seen too. */
  topics: Array<{ id: number; name: string }>;
};

type SeenMessage = {
  chat?: { id?: number; title?: string; first_name?: string; username?: string; type?: string };
  message_thread_id?: number;
  forum_topic_created?: { name?: string };
  forum_topic_edited?: { name?: string };
  reply_to_message?: { forum_topic_created?: { name?: string }; message_thread_id?: number };
};

/**
 * The chats the bot has been told about lately (it was added to a group, somebody wrote to it): how the number of
 * the group is found, and, for a group with topics, the numbers of its topics (write a command in the topic first).
 * Telegram keeps updates for a day.
 */
export async function seenChats(settings: Pick<TelegramSettings, "botToken" | "apiUrl">, fetchImpl: Fetch = fetch): Promise<SeenChat[]> {
  const updates = (await call({ ...settings, groupChatId: "" }, "getUpdates", { limit: 100, timeout: 0 }, fetchImpl)) as Array<
    Record<string, SeenMessage | undefined>
  >;
  const found = new Map<number, SeenChat>();
  for (const update of updates) {
    for (const message of [update.message, update.channel_post, update.my_chat_member, update.edited_message]) {
      const chat = message?.chat;
      if (!message || chat?.id === undefined || !chat.type) continue;
      const seen = found.get(chat.id) ?? { id: chat.id, type: chat.type, title: chat.title ?? chat.first_name ?? chat.username ?? "", topics: [] };
      found.set(chat.id, seen);

      const threadId = message.message_thread_id ?? message.reply_to_message?.message_thread_id;
      if (threadId === undefined) continue;
      const name = message.forum_topic_created?.name ?? message.forum_topic_edited?.name ?? message.reply_to_message?.forum_topic_created?.name ?? "";
      const topic = seen.topics.find((item) => item.id === threadId);
      if (!topic) seen.topics.push({ id: threadId, name });
      else if (name !== "" && topic.name === "") topic.name = name;
    }
  }
  return [...found.values()];
}

export type BotState = {
  /** The name of the bot the token belongs to (without the @). */
  username: string;
  /** The address Telegram delivers updates to; empty when nobody has set a webhook, which is what `getUpdates` needs. */
  webhookUrl: string;
  /** Updates Telegram holds for the bot and nobody has taken. */
  pendingUpdates: number;
  lastWebhookError: string | null;
};

/** Which bot a token is, and whether something else is taking its updates: why `seenChats` may find nothing. */
export async function botState(settings: Pick<TelegramSettings, "botToken" | "apiUrl">, fetchImpl: Fetch = fetch): Promise<BotState> {
  const asking = { ...settings, groupChatId: "" };
  const me = (await call(asking, "getMe", {}, fetchImpl)) as { username?: string };
  const hook = (await call(asking, "getWebhookInfo", {}, fetchImpl)) as { url?: string; pending_update_count?: number; last_error_message?: string };
  return {
    username: me.username ?? "",
    webhookUrl: hook.url ?? "",
    pendingUpdates: hook.pending_update_count ?? 0,
    lastWebhookError: hook.last_error_message ?? null,
  };
}
