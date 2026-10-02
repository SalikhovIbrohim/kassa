import { createServer, type Server } from "node:http";

export type SentMessage = { token: string; chatId: string; threadId: number | undefined; text: string };

/**
 * A Bot API of our own for the tests: it keeps what was sent to it, and can be told to refuse the next requests,
 * so that the queue of messages is seen at work without Telegram.
 */
export type FakeTelegram = {
  url: string;
  /** What was taken, in order. */
  messages: SentMessage[];
  /** How many requests came, taken or not. */
  requests: number;
  /** Refuse the next requests with this status (an error body like Telegram's), `times` times. */
  failNext(status: number, times?: number, retryAfter?: number): void;
  /** Waits until `count` messages have been taken. */
  untilMessages(count: number): Promise<SentMessage[]>;
  /** Answers getUpdates with these updates. */
  setUpdates(updates: unknown[]): void;
  close(): Promise<void>;
};

export async function startFakeTelegram(): Promise<FakeTelegram> {
  const messages: SentMessage[] = [];
  let failures: Array<{ status: number; retryAfter?: number }> = [];
  let updates: unknown[] = [];
  const fake: FakeTelegram = {
    url: "",
    messages,
    requests: 0,
    failNext(status, times = 1, retryAfter) {
      failures = [...failures, ...Array.from({ length: times }, () => ({ status, retryAfter }))];
    },
    async untilMessages(count) {
      for (let attempt = 0; attempt < 200 && messages.length < count; attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
      return messages;
    },
    setUpdates(next) {
      updates = next;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      fake.requests++;
      const [, token, method] = /^\/bot([^/]+)\/(\w+)$/.exec(request.url ?? "") ?? [];
      const answer = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      const failure = method === "sendMessage" ? failures.shift() : undefined;
      if (failure) {
        return answer(failure.status, {
          ok: false,
          error_code: failure.status,
          description: `fake refusal ${failure.status}`,
          ...(failure.retryAfter ? { parameters: { retry_after: failure.retryAfter } } : {}),
        });
      }
      if (method === "sendMessage") {
        const body = JSON.parse(raw) as { chat_id: string; message_thread_id?: number; text: string };
        messages.push({ token: token!, chatId: String(body.chat_id), threadId: body.message_thread_id, text: body.text });
        return answer(200, { ok: true, result: { message_id: messages.length } });
      }
      if (method === "getUpdates") return answer(200, { ok: true, result: updates });
      if (method === "getMe") return answer(200, { ok: true, result: { username: "fakekassabot" } });
      if (method === "getWebhookInfo") return answer(200, { ok: true, result: { url: "", pending_update_count: 0 } });
      return answer(404, { ok: false, error_code: 404, description: "Not Found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The fake Telegram did not bind to a port");
  fake.url = `http://127.0.0.1:${address.port}`;
  return fake;
}
