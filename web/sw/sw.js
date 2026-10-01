// The service worker of Kassa. It keeps the app itself (the page, its scripts and styles, the
// icons) on the phone, so that the app opens without a connection and a cashier can still make
// entries. vite.config.ts fills in the version and the list of files when the app is built.
//
// What it never touches: everything under /api/. Balances, the journal and entries are asked of the
// server every time, and what to do when the server cannot be reached is the business of the app
// (the queue of entries), not of a cache that might show yesterday's money.
"use strict";

const BUILD = "__BUILD__";
const CACHE = "kassa-shell-" + BUILD;
const FILES = __FILES__;
// A page that does not load within this time is taken from the phone instead.
const PAGE_TIMEOUT_MS = 5000;

self.addEventListener("install", (event) => {
  // Everything or nothing: a half-kept app would open and then fail to start.
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.all(FILES.map((url) => cache.add(new Request(url, { cache: "reload" }))))),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("kassa-shell-") && name !== CACHE) await caches.delete(name);
      }
      // The first visit: take over the page that is open now, so that it can reopen offline.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  event.respondWith(request.mode === "navigate" ? openPage(request) : fromPhone(request));
});

// A page: the server first, so that a new version of the app is picked up at once; the copy on the
// phone when the server cannot be reached in time. Inside the app every address is the same page.
async function openPage(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await withTimeout(fetch(request), PAGE_TIMEOUT_MS);
    if (response.ok && (response.headers.get("content-type") || "").includes("text/html")) {
      await cache.put("/", response.clone());
    }
    return response;
  } catch (error) {
    const page = await cache.match("/");
    if (page) return page;
    throw error;
  }
}

// Scripts, styles, icons: from the phone if they are there (their names change with their content),
// from the server otherwise, and kept for next time.
async function fromPhone(request) {
  const cache = await caches.open(CACHE);
  const kept = await cache.match(request);
  if (kept) return kept;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The page did not load in time")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
