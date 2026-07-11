/* Service Worker — macht die App offline-fähig (Bosnien!).
   Wird von build.sh mit Build-Stempel versehen; alte Caches räumen sich selbst auf. */
const CACHE = "lkc-20260711071222";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(["./", "index.html"]).catch(() => c.add("index.html").catch(() => null)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // Externe Dienste (OCM, OSRM, Nominatim, Open-Meteo, GitHub): immer Netz, nie cachen
  if (url.origin !== self.location.origin) return;
  // App-Shell & tarife.json: Netz zuerst (frisch), bei Offline aus dem Cache
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r.ok) {
          const kopie = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, kopie));
        }
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })
        .then(hit => hit || (e.request.mode === "navigate" ? caches.match("index.html") : Response.error())))
  );
});
