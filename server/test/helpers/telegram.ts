import { createHmac } from "node:crypto";

/**
 * What Telegram hands to a Mini App when it opens, signed the way Telegram signs it, for tests: the same rule,
 * written out once more here so that a mistake in the server's reading of it cannot hide behind itself.
 */
export function signedLaunch(
  botToken: string,
  telegramId: number,
  options: { authDate?: Date; extra?: Record<string, string> } = {},
): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor((options.authDate ?? new Date()).getTime() / 1000)),
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: JSON.stringify({ id: telegramId, first_name: "Test", language_code: "ru" }),
    ...options.extra,
  };
  const check = Object.keys(fields)
    .sort()
    .map((name) => `${name}=${fields[name]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}
