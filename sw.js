const CACHE = "amvexa-v9";
const ASSETS = ["/", "/index.html", "/manifest.json", "/icon.svg"];

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE).map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Never cache API calls or navigation documents.
  if (
    url.origin === self.location.origin &&
    (url.pathname.startsWith("/api/") ||
     event.request.mode === "navigate" ||
     event.request.destination === "document")
  ) {
    event.respondWith(fetch(event.request, {cache: "no-store"}));
    return;
  }

  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request, {cache: "no-store"})
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({type: "window", includeUncontrolled: true}).then(clients => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/");
    })
  );
});

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const title = data.title || "Amvexa reminder";
  const options = {
    body: data.body || "आपका Amvexa task due है।",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.taskId ? "amvexa-task-" + data.taskId : "amvexa-reminder",
    renotify: true,
    data: {taskId: data.taskId || null}
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
