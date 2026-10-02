import { parseArgs } from "node:util";
import pg from "pg";
import { getBalances } from "../balances.js";
import { formatAmount } from "../money.js";
import { DatabaseSetupError, MigrationFailedError, migrate } from "../migrate.js";
import { seenChats, sendToGroup, TelegramError } from "../telegram-api.js";
import { setOpeningBalance } from "./opening-balances.js";
import {
  AdminError,
  createUser,
  listUsers,
  resetPassword,
  restoreUser,
  revokeUser,
  type Role,
} from "./users.js";

/** The database is not as this version needs it. Not a failure of the command: nothing was changed. */
const EXIT_DATABASE_NOT_AS_NEEDED = 3;
/** A migration failed and none was applied: the database is as it was (the update script goes back to the old version). */
const EXIT_NOTHING_APPLIED = 4;

const USAGE = `Usage: npm run admin -- <command> [options]

Commands:
  migrate                             apply the database migrations that have not run yet
                                      (the server does this at start too; this lets an update
                                      script see it fail before the new version is started)
  create-user    --login <login> --role <cashier|viewer> [--name <display name>]
  list-users
  revoke-user    --login <login>      block access and end all sessions
  restore-user   --login <login>      give access back (the user logs in again)
  reset-password --login <login>      set a new password and end all sessions
  set-opening-balance --currency <RUB|USD> --amount <1000.50>
                                      the amount a currency's balance starts from
  balances                            current balance per currency (opening balance + income)
  telegram-chats                      the Telegram chats the bot has been told about lately (add it to the group
                                      first): the number of the group for TELEGRAM_GROUP_CHAT_ID
  telegram-test                       send a test message to the group of TELEGRAM_GROUP_CHAT_ID
                                      (into TELEGRAM_THREAD_INCOME and TELEGRAM_THREAD_EXPENSE, if set)

Settings come from the environment: DATABASE_URL is required.
Passwords are never taken from the command line: set KASSA_PASSWORD, or type it when asked.

Exit codes: 0 done; 1 it did not work (the reason is printed); 3 the database is not as this version
needs it (it does not store text as UTF8, or a newer version of Kassa has changed it). An update
script tells the second from the first: the old version stays whole in that case.`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      login: { type: "string" },
      role: { type: "string" },
      name: { type: "string" },
      currency: { type: "string" },
      amount: { type: "string" },
    },
  });

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new AdminError("DATABASE_URL is required");
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    // Makes the first admin command work on a brand-new database too.
    const applied = await migrate(pool, { allowNewerSchema: process.env.ALLOW_NEWER_SCHEMA === "1" });

    switch (command) {
      case "migrate":
        console.log(applied.length > 0 ? `Applied migrations: ${applied.join(", ")}` : "The database is up to date.");
        break;
      case "create-user": {
        const login = required(values.login, "--login");
        const role = required(values.role, "--role") as Role;
        const password = await readPassword(true);
        const user = await createUser(pool, { login, password, role, displayName: values.name });
        console.log(`Created ${user.role} "${user.login}" (${user.displayName}).`);
        break;
      }
      case "list-users": {
        const users = await listUsers(pool);
        if (users.length === 0) {
          console.log("No users yet.");
        }
        for (const user of users) {
          const status = user.active ? "active " : "REVOKED";
          console.log(`${status}  ${user.role.padEnd(7)}  ${user.login}  (${user.displayName})`);
        }
        break;
      }
      case "revoke-user":
        await revokeUser(pool, required(values.login, "--login"));
        console.log(`Access revoked for "${values.login}"; all their sessions are closed.`);
        break;
      case "restore-user":
        await restoreUser(pool, required(values.login, "--login"));
        console.log(`Access restored for "${values.login}". They must log in again.`);
        break;
      case "reset-password": {
        const login = required(values.login, "--login");
        await resetPassword(pool, login, await readPassword(true));
        console.log(`Password changed for "${login}"; all their sessions are closed.`);
        break;
      }
      case "set-opening-balance": {
        const currency = required(values.currency, "--currency");
        const amount = required(values.amount, "--amount");
        const minor = await setOpeningBalance(pool, currency, amount);
        console.log(`Opening balance for ${currency.trim().toUpperCase()} set to ${formatAmount(minor)}.`);
        const entered = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM operations")).rows[0]!.n;
        if (entered > 0) {
          console.log(
            `Note: ${entered} operation(s) are in the book already. The new opening balance replaces the old one, ` +
              "and every balance, including those of past days, moves by the difference. Nothing records the change.",
          );
        }
        break;
      }
      case "balances": {
        for (const balance of await getBalances(pool)) {
          console.log(`${balance.currency}  ${formatAmount(balance.amountMinor)}`);
        }
        break;
      }
      case "telegram-chats": {
        const { botToken, apiUrl } = telegramSettings();
        let chats;
        try {
          chats = await seenChats({ botToken, apiUrl });
        } catch (error) {
          throw new AdminError(telegramProblem(error));
        }
        if (chats.length === 0) {
          console.log(
            "The bot has not been told about any chat yet. Add it to the group, write something there (/start@<the bot's name>), and run this again within a day.",
          );
        }
        for (const chat of chats) {
          console.log(`${String(chat.id).padStart(16)}  ${chat.type.padEnd(11)}  ${chat.title}`);
          for (const topic of chat.topics) {
            console.log(`${"".padStart(16)}  topic ${String(topic.id).padEnd(5)}  ${topic.name}`);
          }
        }
        if (chats.some((chat) => chat.topics.length > 0)) {
          console.log(
            "\nThe group has topics. Put the number of the topic for the incomes in TELEGRAM_THREAD_INCOME and the one for the expenses in TELEGRAM_THREAD_EXPENSE; " +
              "a kind that has none goes to the main topic. " +
              "A topic shows here only after a command was written in it (/start@<the bot's name>).",
          );
        }
        break;
      }
      case "telegram-test": {
        const { botToken, apiUrl } = telegramSettings();
        const groupChatId = process.env.TELEGRAM_GROUP_CHAT_ID?.trim();
        if (!groupChatId) throw new AdminError("TELEGRAM_GROUP_CHAT_ID is not set in the settings file");
        const topic = (name: string) => (process.env[name]?.trim() ? Number(process.env[name]!.trim()) : undefined);
        const incomeThread = topic("TELEGRAM_THREAD_INCOME");
        const expenseThread = topic("TELEGRAM_THREAD_EXPENSE");
        // One message into each topic that is set, or into the main topic when none is.
        const targets: Array<{ thread: number | undefined; about: string }> =
          incomeThread === undefined && expenseThread === undefined
            ? [{ thread: undefined, about: "" }]
            : [
                ...(incomeThread === undefined ? [] : [{ thread: incomeThread, about: " Эта тема для приходов." }]),
                ...(expenseThread === undefined ? [] : [{ thread: expenseThread, about: " Эта тема для расходов." }]),
              ];
        try {
          for (const target of targets) {
            await sendToGroup({ botToken, groupChatId, apiUrl }, `✅ Касса: проверка связи.${target.about}`, target.thread);
            console.log(`Sent a test message to ${groupChatId}${target.thread === undefined ? "" : `, topic ${target.thread}`}.`);
          }
        } catch (error) {
          throw new AdminError(telegramProblem(error));
        }
        break;
      }
      default:
        throw new AdminError(`Unknown command "${command}"\n\n${USAGE}`);
    }
  } finally {
    await pool.end();
  }
}

function telegramSettings(): { botToken: string; apiUrl: string } {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) throw new AdminError("TELEGRAM_BOT_TOKEN is not set in the settings file");
  return { botToken, apiUrl: (process.env.TELEGRAM_API_URL?.trim() || "https://api.telegram.org").replace(/\/+$/, "") };
}

/** What went wrong with Telegram, in words, and what usually mends it. The token is never in it. */
function telegramProblem(error: unknown): string {
  if (!(error instanceof TelegramError)) return "Telegram did not answer as expected";
  const hint = error.permanent
    ? " Check the number of the group (it starts with -), that the bot is in the group, and that the token is the bot's."
    : " The server may not reach api.telegram.org: try opening https://api.telegram.org in a browser on the server.";
  return `${error.message}.${hint}`;
}

function required(value: string | undefined, flag: string): string {
  if (!value) {
    throw new AdminError(`${flag} is required`);
  }
  return value;
}

async function readPassword(confirm: boolean): Promise<string> {
  const fromEnv = process.env.KASSA_PASSWORD;
  if (fromEnv) {
    return fromEnv;
  }
  if (!process.stdin.isTTY) {
    throw new AdminError("Set KASSA_PASSWORD, or run this in a terminal to type the password");
  }
  const first = await promptHidden("Password: ");
  if (confirm && first !== (await promptHidden("Repeat password: "))) {
    throw new AdminError("The passwords do not match");
  }
  return first;
}

/** Reads a line from the terminal without echoing it. Works in Windows and Unix terminals. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let typed = "";
    const finish = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      error ? reject(error) : resolve(typed);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003") return finish(new AdminError("Cancelled"));
        if (char === "\u007f" || char === "\b") typed = typed.slice(0, -1);
        else typed += char;
      }
    };
    stdin.on("data", onData);
  });
}

main().catch((error: unknown) => {
  const code = (error as { code?: string }).code;
  if (error instanceof DatabaseSetupError) {
    console.error(`Error: ${error.message}`);
    process.exit(EXIT_DATABASE_NOT_AS_NEEDED);
  } else if (error instanceof MigrationFailedError) {
    const before = error.applied.length === 0 ? " Nothing was applied: the database is as it was." : ` Applied before it: ${error.applied.join(", ")}.`;
    console.error(`Error: ${error.message}.${before}`);
    process.exit(error.applied.length === 0 ? EXIT_NOTHING_APPLIED : 1);
  } else if (error instanceof AdminError) {
    console.error(`Error: ${error.message}`);
  } else if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
    // Bad command-line options: show the message, not a stack trace.
    console.error(`Error: ${(error as Error).message}\n\n${USAGE}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
