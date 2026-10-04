"use client";

export function arePushNotificationsSupported() {
  return (
    typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = typeof window === "undefined" ? "" : window.atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!arePushNotificationsSupported()) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

export async function getPushPermissionState(): Promise<NotificationPermission | "unsupported"> {
  if (!arePushNotificationsSupported()) return "unsupported";
  return Notification.permission;
}

export async function subscribeToPush(): Promise<{ ok: boolean; error?: string; publicKey?: string | null }> {
  if (!arePushNotificationsSupported()) {
    return { ok: false, error: "Браузер не поддерживает push-уведомления" };
  }
  try {
    const configRes = await fetch("/api/push/subscribe", { cache: "no-store" });
    const config = await configRes.json().catch(() => ({}));
    if (!config.configured || !config.publicKey) {
      return { ok: false, error: "Push-уведомления не настроены на сервере" };
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      return { ok: false, error: "Разрешение на уведомления не выдано" };
    }
    const registration = (await navigator.serviceWorker.ready) || await registerServiceWorker();
    if (!registration) return { ok: false, error: "Не удалось зарегистрировать Service Worker" };

    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      // Check if the existing subscription matches our VAPID key; if not, re-subscribe.
      const existingKey = existing.options.applicationServerKey;
      const newKey = urlBase64ToUint8Array(config.publicKey);
      const keysMatch = existingKey instanceof ArrayBuffer
        && existingKey.byteLength === newKey.byteLength
        && new Uint8Array(existingKey).every((b, i) => b === newKey[i]);
      if (!keysMatch) await existing.unsubscribe().catch(() => undefined);
    }

    const applicationKey = urlBase64ToUint8Array(config.publicKey);
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationKey as BufferSource,
    });
    const p256dhKey = subscription.getKey("p256dh");
    const authKey = subscription.getKey("auth");
    if (!p256dhKey || !authKey) return { ok: false, error: "Не удалось получить ключи подписки" };

    const p256dh = btoa(String.fromCharCode(...new Uint8Array(p256dhKey)));
    const auth = btoa(String.fromCharCode(...new Uint8Array(authKey)));

    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint, p256dh, auth }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.error || "Не удалось сохранить подписку" };
    }
    return { ok: true, publicKey: config.publicKey };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Не удалось подписаться на уведомления" };
  }
}

export async function unsubscribeFromPush(): Promise<{ ok: boolean }> {
  if (!arePushNotificationsSupported()) return { ok: true };
  try {
    const registration = await navigator.serviceWorker.ready;
    const sub = await registration.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe().catch(() => undefined);
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      }).catch(() => undefined);
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
