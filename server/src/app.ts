import { extname, relative, sep } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { createDatabase } from "./db.js";

export type AppOptions = {
  databaseUrl: string;
  /** Folder with the built web app. When set, the server also serves it. */
  webDistDir?: string;
  logger?: boolean;
};

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const database = createDatabase(options.databaseUrl);

  app.addHook("onClose", async () => {
    await database.close();
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
      const { pathname } = new URL(request.url, "http://localhost");
      const isApi = pathname === "/api" || pathname.startsWith("/api/");
      const wantsShell = request.method === "GET" && !isApi && !extname(pathname);
      if (wantsShell) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not_found" });
    });
  }

  return app;
}
