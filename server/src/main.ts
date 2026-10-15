import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { migrateDatabase } from "./migrate.js";

const config = loadConfig();

// Fail fast if the database is down or a migration breaks: the process manager restarts us.
const applied = await migrateDatabase(config.databaseUrl, { allowNewerSchema: config.allowNewerSchema });
if (applied.length > 0) {
  console.log(`Applied migrations: ${applied.join(", ")}`);
}

if (config.sheetProblem) console.error(`The journal is not copied to the Google spreadsheet: ${config.sheetProblem}`);

const app = await buildApp({
  databaseUrl: config.databaseUrl,
  webDistDir: config.webDistDir,
  secureCookies: config.secureCookies,
  sessionDays: config.sessionDays,
  trustProxy: config.trustProxy,
  telegramBotToken: config.telegramBotToken,
  telegramGroupChatId: config.telegramGroupChatId,
  telegramIncomeThreadId: config.telegramIncomeThreadId,
  telegramExpenseThreadId: config.telegramExpenseThreadId,
  telegramAndijanThreadId: config.telegramAndijanThreadId,
  telegramApiUrl: config.telegramApiUrl,
  onec: config.onec,
  sheet: config.sheet,
  logger: true,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

await app.listen({ host: config.host, port: config.port });
