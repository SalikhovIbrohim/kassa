import { extname, relative, sep } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "./auth.js";
import { createDatabase } from "./db.js";
import { registerOperations } from "./operations.js";
import { isApiPath, pathnameOf } from "./paths.js";

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
};

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    // A wrong type or an unexpected field is a bad request, never quietly "fixed".
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  const database = createDatabase(options.databaseUrl);

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
  });

  await registerOperations(app, {
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
