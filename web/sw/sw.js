// The service worker of Kassa. It keeps the app itself (the page, its scripts and styles, the
// icons) on the phone, so that the app opens without a connection and a cashier can still make
// entries. vite.config.ts fills in the version and the list of files when the app is built.
//
// What it never touches: everything under /api/. Balances, the journal and entries are asked of the
// server every time, and what to do when the server cannot be reached is the business of the app
// (the queue of entries), not of a cache that might show yesterday's money.
//
// The copy on the phone is made once, whole, when a version is installed, and is never patched
// afterwards: a page from one version with the scripts of another would open blank. A new version is
// installed beside the old one and takes over only when it is complete.
"use strict";

const BUILD = "__BUILD__";
const CACHE = "kassa-shell-" + BUILD;
const FILES = __FILES__;
// A page that does not load within this time is taken from the phone instead.
const PAGE_TIMEOUT_MS = 5000;

self.addEventListener("install", (event) => {
  // Everything or nothing: a half-kept app would open and then fail to start.
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(FILES.map((url) => keepFile(cache, url)));
      // Complete: this version need not wait for every open page to close before it takes over.
      await self.skipWaiting();
    })(),
  );
});

// Fetches one file of the app afresh and keeps it. A sign-in page of a public Wi-Fi, or a proxy, answers every
// address with 200 and a page of its own: that must not be kept as a script, or the app would stay blank for
// this version until the next one.
async function keepFile(cache, url) {
  const request = new Request(url, { cache: "reload" });
  const response = await fetch(request);
  if (!response.ok) throw new Error(url + " answered " + response.status);
  const type = response.headers.get("content-type") || "";
  if (url !== "/" && type.toLowerCase().indexOf("text/html") === 0) throw new Error(url + " is a page, not the file");
  await cache.put(request, response);
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        for (const name of await caches.keys()) {
          if (name.startsWith("kassa-shell-") && name !== CACHE) await caches.delete(name);
        }
      } catch {
        // an old copy that stays is only wasted room
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

  event.respondWith(request.mode === "navigate" ? openPage(request) : fromPhone(event, request));
});

// What is on the phone for this request, or nothing. A phone whose storage fails (full, damaged) is no
// reason to fail the page: everything here falls through to the server.
async function kept(request) {
  try {
    const cache = await caches.open(CACHE);
    return (await cache.match(request)) || null;
  } catch {
    return null;
  }
}

async function remember(request, response) {
  try {
    const cache = await caches.open(CACHE);
    await cache.put(request, response);
  } catch {
    // not kept; the next visit asks the server again
  }
}

// A page: the server first, so that a new version of the app is picked up at once; the copy on the
// phone when the server cannot be reached in time, or when it answers with an error of its own (the
// application is being updated or has stopped, and the proxy in front of it says 502, 503 or 504): the
// app opens, keeps the entries on the phone, and sends them when the server is back. Inside the app
// every address is the same page.
async function openPage(request) {
  let response = null;
  try {
    response = await withTimeout(fetch(request), PAGE_TIMEOUT_MS);
  } catch {
    // no connection, or no answer in time
  }
  if (response && response.status < 500) return response;
  const page = await kept("/");
  if (page) return page;
  // Nothing on the phone to show instead: whatever the server said, or the browser's own error page.
  return response || Response.error();
}

// Scripts, styles, icons: from the phone if they are there (their names change with their content),
// from the server otherwise, and kept for next time.
async function fromPhone(event, request) {
  const hit = await kept(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) event.waitUntil(remember(request, response.clone()));
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
