import { extname, relative, sep } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { registerAuth, type LoginProtectionOptions } from "./auth.js";
import { createDatabase } from "./db.js";
import { registerJournal } from "./journal.js";
import { registerOperations } from "./operations.js";
import { isApiPath, pathnameOf } from "./paths.js";

export type { LoginProtectionOptions };

export type AppOptions = {
  databaseUrl: string;
  /** Folder with the built web app. When set, the server also serves it. */
  webDistDir?: string;
  logger?: boolean;
  /** The application's clock. Sessions expire by it, so tests can move it. */
  now?: () => Date;
  /** Sends the session cookie only over HTTPS. Turn off for plain-HTTP development. */
  secureCookies?: boolean;
  /** How long a session lives without use. */
  sessionDays?: number;
  /**
   * Addresses of reverse proxies (e.g. "127.0.0.1" for Caddy on the same machine) whose
   * X-Forwarded-For header is believed when working out who a client is. Unset: the
   * header is ignored and the address of the connection is used.
   */
  trustProxy?: string | string[];
  loginProtection?: LoginProtectionOptions;
};

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: options.trustProxy ?? false,
    // A wrong type or an unexpected field is a bad request, never quietly "fixed".
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  const database = createDatabase(options.databaseUrl);

  // Mistakes of the client keep Fastify's standard answer. Anything unexpected is logged here
  // and answered with fixed words: a database error must never travel to the browser.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode < 500) return reply.send(error);
    request.log.error(error);
    return reply.code(500).send({ statusCode: 500, error: "Internal Server Error", message: "Internal error" });
  });

  app.addHook("onClose", async () => {
    await database.close();
  });

  // API answers are personal and live: never let a browser or proxy keep them.
  app.addHook("onSend", async (request, reply) => {
    if (isApiPath(pathnameOf(request.url))) {
      reply.header("Cache-Control", "no-store");
    }
  });

  await registerAuth(app, {
    pool: database.pool,
    now: options.now ?? (() => new Date()),
    sessionDays: options.sessionDays ?? 90,
    secureCookies: options.secureCookies ?? false,
    loginProtection: options.loginProtection,
  });

  await registerOperations(app, {
    pool: database.pool,
    now: options.now ?? (() => new Date()),
  });

  await registerJournal(app, {
    pool: database.pool,
    now: options.now ?? (() => new Date()),
  });

  app.get("/api/health", async (_request, reply) => {
    const databaseUp = await database.ping();
    return reply
      .code(databaseUp ? 200 : 503)
      .send({ status: databaseUp ? "ok" : "error", database: databaseUp ? "up" : "down" });
  });

  if (options.webDistDir) {
    const webDistDir = options.webDistDir;
    await app.register(fastifyStatic, {
      root: webDistDir,
      // Revalidate by default so the shell and manifest follow every deploy.
      cacheControl: false,
      setHeaders(reply, path) {
        // Vite fingerprints everything under /assets/, so those files never change.
        const fingerprinted = relative(webDistDir, path).startsWith(`assets${sep}`);
        reply.header(
          "Cache-Control",
          fingerprinted ? "public, max-age=31536000, immutable" : "no-cache",
        );
      },
    });

    // Deep links belong to the client-side router: answer them with the shell.
    // API routes and missing files (anything with an extension) stay real 404s.
    app.setNotFoundHandler((request, reply) => {
      const pathname = pathnameOf(request.url);
      const wantsShell =
        request.method === "GET" && !isApiPath(pathname) && !extname(pathname);
      if (wantsShell) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not_found" });
    });
  }

  return app;
}
