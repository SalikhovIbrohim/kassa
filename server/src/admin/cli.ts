import { parseArgs } from "node:util";
import pg from "pg";
import { getBalances } from "../balances.js";
import { formatAmount } from "../money.js";
import { migrate } from "../migrate.js";
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

Settings come from the environment: DATABASE_URL is required.
Passwords are never taken from the command line: set KASSA_PASSWORD, or type it when asked.`;

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
    const applied = await migrate(pool);

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
        break;
      }
      case "balances": {
        for (const balance of await getBalances(pool)) {
          console.log(`${balance.currency}  ${formatAmount(balance.amountMinor)}`);
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
  if (error instanceof AdminError) {
    console.error(`Error: ${error.message}`);
  } else if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
    // Bad command-line options: show the message, not a stack trace.
    console.error(`Error: ${(error as Error).message}\n\n${USAGE}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
