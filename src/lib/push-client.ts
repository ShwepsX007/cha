"use client";

export function arePushNotificationsSupported() {
  return (
    typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window
  );
}

export function isIosSafari(): { isIOS: boolean; isStandalone: boolean } {
  if (typeof navigator === "undefined") return { isIOS: false, isStandalone: false };
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const nav = window.navigator as Navigator & { standalone?: boolean };
  const isStandalone = Boolean(nav.standalone);
  return { isIOS, isStandalone };
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
    return await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
  } catch {
    return null;
  }
}

async function waitForActiveServiceWorker(timeoutMs = 10_000): Promise<ServiceWorkerRegistration | null> {
  const registration = await registerServiceWorker();
  if (!registration) return null;
  if (registration.active) return registration;

  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => resolve(null), timeoutMs);
    void navigator.serviceWorker.ready.then((readyRegistration) => {
      window.clearTimeout(timeout);
      resolve(readyRegistration);
    }, () => {
      window.clearTimeout(timeout);
      resolve(null);
    });
  });
}

export async function getPushPermissionState(): Promise<NotificationPermission | "unsupported"> {
  if (!arePushNotificationsSupported()) return "unsupported";
  return Notification.permission;
}

export async function subscribeToPush(): Promise<{ ok: boolean; error?: string; publicKey?: string | null; denied?: boolean; iosHint?: boolean }> {
  if (!arePushNotificationsSupported()) {
    return { ok: false, error: "Браузер не поддерживает push-уведомления" };
  }
  try {
    const configRes = await fetch("/api/push/subscribe", { cache: "no-store" });
    const config = await configRes.json().catch(() => ({}));
    if (!configRes.ok || !config.configured || !config.publicKey) {
      return { ok: false, error: config.error || "Push-уведомления не настроены на сервере (задайте VAPID-ключи в .env)" };
    }

    // ready may remain pending forever if registration failed; use a bounded
    // wait and give the user an actionable error instead of a stuck button.
    const registration = await waitForActiveServiceWorker();
    if (!registration) {
      return { ok: false, error: "Service Worker не активировался. Проверьте HTTPS и доступность /sw.js, затем обновите страницу." };
    }

    // If user already denied permission, report it clearly.
    if (Notification.permission === "denied") {
      return { ok: false, denied: true, error: "Уведомления заблокированы в настройках браузера. Разрешите их в адресной строке и повторите." };
    }

    let permission: NotificationPermission = Notification.permission;
    if (permission === "default") {
      try {
        permission = await Notification.requestPermission();
      } catch {
        permission = Notification.permission;
      }
    }
    if (permission !== "granted") {
      if (permission === "denied") {
        return { ok: false, denied: true, error: "Уведомления заблокированы в настройках браузера." };
      }
      return { ok: false, error: "Разрешение на уведомления не выдано." };
    }

    const { isIOS, isStandalone } = isIosSafari();
    if (isIOS && !isStandalone) {
      // Subscribing may still work but iOS will only deliver pushes for installed PWAs.
      // Continue but pass a hint.
    }

    // Check existing subscription: if it exists with our key, reuse; else re-subscribe.
    const applicationKey = urlBase64ToUint8Array(config.publicKey);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      const existingKey = subscription.options.applicationServerKey;
      const keysMatch = existingKey instanceof ArrayBuffer
        && existingKey.byteLength === applicationKey.byteLength
        && new Uint8Array(existingKey).every((b, i) => b === applicationKey[i]);
      if (!keysMatch) {
        await subscription.unsubscribe().catch(() => undefined);
        subscription = null;
      }
    }

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationKey as BufferSource,
      });
    }

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
    return {
      ok: true,
      publicKey: config.publicKey,
      iosHint: isIOS && !isStandalone,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Не удалось подписаться на уведомления" };
  }
}

export async function unsubscribeFromPush(): Promise<{ ok: boolean }> {
  if (!arePushNotificationsSupported()) return { ok: true };
  try {
    const registration = await navigator.serviceWorker.ready.catch(() => null);
    if (registration) {
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
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
