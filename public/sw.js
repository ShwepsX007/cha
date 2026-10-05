/* Secret Chat push service worker */
self.addEventListener("push", (event) => {
  let data = { title: "Secret Chat", body: "Новое сообщение", url: "/" };
  try {
    data = { ...data, ...(event.data ? event.data.json() : {}) };
  } catch {
    /* ignore malformed payload */
  }
  const title = data.title || "Secret Chat";
  const options = {
    body: data.body || "У вас новое сообщение",
    icon: "/apple-touch-icon.png",
    badge: "/favicon-32.png",
    vibrate: [120, 60, 120],
    data: { url: data.url || "/", chatId: data.chatId || null },
    tag: data.chatId ? `chat-${data.chatId}` : "chata-message",
    renotify: true,
  };
  event.waitUntil((async () => {
    try {
      // Suppress only when a visible Secret Chat tab is already showing this
      // exact conversation. A different foreground chat must not hide the
      // notification, and stale server-side lastSeen values are irrelevant.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const chatIsVisible = windows.some((client) => {
        if (client.visibilityState !== "visible" || !data.chatId) return false;
        try {
          const url = new URL(client.url);
          return url.origin === self.location.origin && url.searchParams.get("chatId") === String(data.chatId);
        } catch {
          return false;
        }
      });
      if (!data.force && chatIsVisible) return;
      await self.registration.showNotification(title, options);
    } catch {
      /* Push is best-effort. */
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of allClients) {
        try {
          if ("focus" in client) {
            client.postMessage && client.postMessage({ type: "chata-open-chat", url });
            return await client.focus();
          }
        } catch {
          /* continue */
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })().catch(() => undefined),
  );
});
