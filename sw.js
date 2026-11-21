// Zion OS service worker: only handles Web Push, caches nothing (so the app always loads the newest version).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) {}
  const title = d.title || "Zion OS";
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    list.forEach((c) => c.postMessage({ type: "push", title, body: d.body || "", url: d.url || "./" }));
    await self.registration.showNotification(title, {
      body: d.body || "",
      icon: "icon-192.png",
      badge: "icon-192.png",
      tag: d.tag || "zion",
      data: { url: d.url || "./" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL((event.notification.data && event.notification.data.url) || "./", self.registration.scope).href;
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Zion is already open: bring it up and tell it which page (and custom) to show
    for (const c of list) { if ("focus" in c) { await c.focus(); try { c.postMessage({ type: "zion-open", url }); } catch (e) {} return; } }
    await self.clients.openWindow(url);
  })());
});
