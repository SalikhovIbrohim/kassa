/// <reference types="node" />
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Writes dist/sw.js: the service worker (sw/sw.js) with this build's version and the list of every
 * file of the app, which the phone keeps so that the app opens without a connection. A new build
 * has a new version, so a phone drops the files of the old one.
 */
function serviceWorker(): Plugin {
  return {
    name: "kassa-service-worker",
    apply: "build",
    // After the bundle and the public folder are both in the output folder.
    writeBundle(options) {
      const outDir = options.dir;
      if (!outDir) throw new Error("The service worker needs the output folder");

      const found: string[] = [];
      const walk = (folder: string) => {
        for (const name of readdirSync(folder)) {
          const path = join(folder, name);
          if (statSync(path).isDirectory()) walk(path);
          else found.push(relative(outDir, path).split(sep).join("/"));
        }
      };
      walk(outDir);

      const files = found
        .filter((file) => file !== "sw.js" && !file.endsWith(".map"))
        .sort()
        // The page itself is kept under "/", wherever the app is opened.
        .map((file) => (file === "index.html" ? "/" : `/${file}`));

      const hash = createHash("sha256");
      for (const file of found.slice().sort()) {
        if (file === "sw.js") continue;
        hash.update(file).update(readFileSync(join(outDir, file)));
      }

      const filled = (template: string, placeholder: string, value: string) => {
        if (template.split(placeholder).length !== 2) throw new Error(`sw/sw.js must contain ${placeholder} exactly once`);
        return template.replace(placeholder, () => value);
      };
      let text = readFileSync(new URL("./sw/sw.js", import.meta.url), "utf8");
      text = filled(text, "__BUILD__", hash.digest("hex").slice(0, 12));
      text = filled(text, "__FILES__", JSON.stringify(files, null, 2));
      writeFileSync(join(outDir, "sw.js"), text);
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: {
    // In development the API runs as a separate process.
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
});
