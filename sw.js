// Triad service worker — makes the app installable and fully usable offline.
// Bump CACHE when assets change to invalidate the old cache.
const CACHE = "triad-v2-4";

const ASSETS = [
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./src/starter.js",
  "./src/storage.js",
  "./vendor/codemirror/lib/codemirror.js",
  "./vendor/codemirror/lib/codemirror.css",
  "./vendor/codemirror/addon/dialog/dialog.css",
  "./vendor/codemirror/addon/dialog/dialog.js",
  "./vendor/codemirror/addon/search/search.js",
  "./vendor/codemirror/addon/search/searchcursor.js",
  "./vendor/codemirror/addon/edit/closebrackets.js",
  "./vendor/codemirror/addon/edit/matchbrackets.js",
  "./vendor/codemirror/addon/edit/closetag.js",
  "./vendor/codemirror/addon/selection/active-line.js",
  "./vendor/codemirror/mode/xml/xml.js",
  "./vendor/codemirror/mode/javascript/javascript.js",
  "./vendor/codemirror/mode/css/css.js",
  "./vendor/codemirror/mode/htmlmixed/htmlmixed.js"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    // Per-asset add so one bad/renamed path can't abort the whole precache and
    // leave installed users on a broken offline copy.
    caches.open(CACHE)
      .then((c) => Promise.all(ASSETS.map((a) => c.add(a).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Let cross-origin requests (e.g. Google Fonts) go straight to the network.
  if (url.origin !== self.location.origin) return;

  // Navigations: try network, fall back to the cached shell when offline.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("./index.html")));
    return;
  }

  // Same-origin assets: serve cache immediately but revalidate in the background,
  // so an edited app.js/styles.css reaches clients on the next load even if CACHE
  // wasn't bumped. Only successful, non-opaque responses are ever written to cache.
  e.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.status === 200 && (res.type === "basic" || res.type === "cors")) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => null);
    if (cached) { void network; return cached; } // stale-while-revalidate
    const res = await network;
    return res || Response.error();
  })());
});
