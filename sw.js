/* Work Reminder — service worker.
   Caches the whole app for offline use and turns notification actions into
   messages the page can apply (done / snooze). */
"use strict";

const VERSION = "1.2.0";
const CACHE = "workreminder-app-v" + VERSION;

const ASSETS = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./shared.js",
  "./sounds.js",
  "./voice.js",
  "./manifest.webmanifest",
  "./fonts/inter-latin-var.woff2",
  "./fonts/inter-latin-ext-var.woff2",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
  "./icons/badge-96.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Cache each asset independently so one 404 cannot fail the whole install.
    await Promise.all(ASSETS.map((url) => cache.add(url).catch(() => {})));
    // A fresh install has no active worker and activates normally. For an
    // existing install the new worker waits here until the user taps Update,
    // which posts SKIP_WAITING below. That keeps updates deliberate instead of
    // swapping code underneath someone mid-reminder.
  })());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") self.skipWaiting();

  // Update notifications are shown from the worker rather than the page: it
  // still works when the tab is backgrounded and does not depend on the page
  // holding the notification handle. The page gets a small receipt so it can
  // fall back to registration.showNotification() if this fails.
  if (data.type === "WR_NOTIFY" && data.title) {
    const reply = (ok, error) => {
      if (event.source && event.source.postMessage) {
        event.source.postMessage({ type: "WR_NOTIFY_RESULT", id: data.id, ok, error: error || "" });
      }
    };
    event.waitUntil(
      self.registration.showNotification(data.title, data.options || {})
        .then(() => reply(true))
        .catch((e) => reply(false, String((e && e.message) || e)))
    );
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // The update manifest must always be fresh. Bypass the cache entirely so a
  // new deployment is noticed on the next check, and never store query-string
  // variants of it.
  if (url.pathname.endsWith("/version.json")) {
    event.respondWith(fetch(req, { cache: "no-store" }).catch(() =>
      new Response('{"error":"offline"}', {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })));
    return;
  }

  // Navigations: network first, fall back to the cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put("./index.html", fresh.clone()).catch(() => {});
        return fresh;
      } catch (e) {
        const cache = await caches.open(CACHE);
        return (await cache.match("./index.html")) || (await cache.match("./")) ||
          new Response("Work Reminder is offline.", { status: 503, headers: { "Content-Type": "text/plain" } });
      }
    })());
    return;
  }

  // Assets: images and fonts are cache-first (they rarely change); code,
  // styles and the manifest are network-first so a new deployment is picked
  // up immediately, with the cached copy as the offline fallback.
  const cacheFirst = req.destination === "image" || req.destination === "font";
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (cacheFirst && hit) return hit;
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
      return fresh;
    } catch (e) {
      if (hit) return hit;
      return new Response("", { status: 504 });
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  const note = event.notification;
  const data = (note && note.data) || {};
  const action = event.action || "open";
  if (note) note.close();

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const page = all.find((c) => c.url.startsWith(self.registration.scope));

    if (page) {
      try { await page.focus(); } catch (e) {}
      if (data.whatsnew) {
        page.postMessage({ type: "wr-whatsnew", version: data.version || "" });
        return;
      }
      if (action === "update" || data.update) {
        page.postMessage({ type: "wr-update", version: data.version || "" });
        return;
      }
      page.postMessage({ type: "wr-action", action, id: data.id || "" });
      return;
    }

    // No open window: launch the app with the intent in the URL so it can
    // apply the change once it has loaded its local state.
    const target = new URL("./", self.registration.scope);
    if (data.whatsnew) {
      target.searchParams.set("whatsnew", "1");
    } else if (action === "update" || data.update) {
      target.searchParams.set("update", "1");
    } else if (action !== "open" && data.id) {
      target.searchParams.set("action", action);
      target.searchParams.set("id", data.id);
    }
    try {
      await self.clients.openWindow(target.href);
    } catch (e) {}
  })());
});

self.addEventListener("notificationclose", () => {
  // Nothing to clean up — the reminder keeps its normal schedule.
});
