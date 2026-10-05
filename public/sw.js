/* Secret Chat push service worker */

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = self.atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) output[i] = rawData.charCodeAt(i);
  return output;
}

function arrayBufferToBase64(buffer) {
  return self.btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

/**
 * Re-create the push subscription and hand it back to the app server. Used
 * when the browser rotates the endpoint (`pushsubscriptionchange`): without
 * this the DB keeps the dead endpoint until its `410 Gone` cleanup, and the
 * user silently stops receiving notifications until they re-click the switch
 * in the profile settings.
 */
async function resubscribeAndReport(registration) {
  const configRes = await fetch("/api/push/subscribe", { cache: "no-store" });
  if (!configRes.ok) return;
  const config = await configRes.json().catch(() => null);
  if (!config || !config.configured || !config.publicKey) return;
  let subscription = await registration.pushManager.getSubscription().catch(() => null);
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.publicKey),
    });
  }
  const p256dh = subscription.getKey("p256dh");
  const auth = subscription.getKey("auth");
  if (!p256dh || !auth) return;
  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: subscription.endpoint,
      p256dh: arrayBufferToBase64(p256dh),
      auth: arrayBufferToBase64(auth),
    }),
  });
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(resubscribeAndReport(self.registration).catch(() => undefined));
});

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
    icon: "/chata-icon-192.png",
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
        // "Visible" is not "being looked at": a second monitor or an unfocused
        // window is still visible, and suppressing there reads as "notifications
        // are broken". Only a focused tab showing this exact chat suppresses.
        if (typeof client.focused === "boolean" && !client.focused) return false;
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
