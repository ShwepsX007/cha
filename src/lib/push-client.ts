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

/**
 * Get a browser push subscription bound to `publicKey`. If an existing
 * subscription was created with a different (older) VAPID key it is replaced,
 * because deliveries to it would be rejected by the push service.
 */
async function ensureBrowserSubscription(
  registration: ServiceWorkerRegistration,
  publicKey: string,
): Promise<PushSubscription | null> {
  const applicationKey = urlBase64ToUint8Array(publicKey);
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
  return subscription;
}

/** Send the current subscription to the app server (upserts by endpoint). */
async function reportSubscription(subscription: PushSubscription): Promise<boolean> {
  const p256dhKey = subscription.getKey("p256dh");
  const authKey = subscription.getKey("auth");
  if (!p256dhKey || !authKey) return false;
  const p256dh = btoa(String.fromCharCode(...new Uint8Array(p256dhKey)));
  const auth = btoa(String.fromCharCode(...new Uint8Array(authKey)));
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint, p256dh, auth }),
  });
  return res.ok;
}

/**
 * Silent push re-registration on app load. Browsers rotate push endpoints over
 * time and the server prunes rows that answer `410 Gone`, so a subscription
 * saved once is not guaranteed to still exist months later. While the user has
 * granted the notification permission, refresh the browser↔server pairing on
 * every start - no prompts, no UI, no failures thrown.
 */
export async function ensurePushSubscription(): Promise<boolean> {
  if (!arePushNotificationsSupported()) return false;
  try {
    if (Notification.permission !== "granted") return false;
    const registration = await waitForActiveServiceWorker(8_000);
    if (!registration) return false;
    const configRes = await fetch("/api/push/subscribe", { cache: "no-store" });
    if (!configRes.ok) return false;
    const config = await configRes.json().catch(() => ({}));
    if (!config.configured || typeof config.publicKey !== "string" || !config.publicKey) return false;
    const subscription = await ensureBrowserSubscription(registration, config.publicKey);
    if (!subscription) return false;
    return await reportSubscription(subscription);
  } catch {
    return false;
  }
}

export async function subscribeToPush(): Promise<{ ok: boolean; error?: string; publicKey?: string | null; denied?: boolean; iosHint?: boolean }> {
  if (!arePushNotificationsSupported()) {
    return {
      ok: false,
      error: typeof window !== "undefined" && window.isSecureContext === false
        ? "Push требует HTTPS: откройте приложение по https:// (или localhost)."
        : "Браузер не поддерживает push-уведомления",
    };
  }

  try {
    // 1) Permission FIRST, while the button click is still the active user
    //    gesture. Chrome only shows the prompt with a transient user
    //    activation (~5s) and otherwise leaves the promise pending forever, so
    //    awaiting the config and the service worker *before* asking used to
    //    make the button look dead.
    if (Notification.permission === "denied") {
      return {
        ok: false,
        denied: true,
        error: "Уведомления заблокированы в настройках браузера. Разрешите их в адресной строке и повторите.",
      };
    }
    let permission: NotificationPermission = Notification.permission;
    if (permission === "default") {
      try {
        permission = await Notification.requestPermission();
      } catch {
        permission = Notification.permission;
      }
      if (permission !== "granted") {
        return permission === "denied"
          ? { ok: false, denied: true, error: "Разрешение на уведомления не выдано." }
          : { ok: false, error: "Разрешение на уведомления не выдано." };
      }
    }

    // 2) Now the server config and the service worker.
    const configRes = await fetch("/api/push/subscribe", { cache: "no-store" });
    const config = await configRes.json().catch(() => ({}));
    if (!configRes.ok || !config.configured || !config.publicKey) {
      const missing = Array.isArray(config.missingEnv) ? (config.missingEnv as string[]).join(", ") : "";
      return {
        ok: false,
        error: config.error
          || `Push-уведомления не настроены на сервере${missing ? ` (не задано: ${missing})` : " (задайте VAPID-ключи и VAPID_EMAIL в .env)"}`,
      };
    }

    // ready may remain pending forever if registration failed; use a bounded
    // wait and give the user an actionable error instead of a stuck button.
    const registration = await waitForActiveServiceWorker();
    if (!registration) {
      return { ok: false, error: "Service Worker не активировался. Проверьте HTTPS и доступность /sw.js, затем обновите страницу." };
    }

    const { isIOS, isStandalone } = isIosSafari();
    if (isIOS && !isStandalone) {
      // Subscribing may still work but iOS will only deliver pushes for installed PWAs.
      // Continue but pass a hint.
    }

    // Check existing subscription: if it exists with our key, reuse; else re-subscribe.
    const subscription = await ensureBrowserSubscription(registration, config.publicKey);
    if (!subscription) return { ok: false, error: "Не удалось получить ключи подписки" };
    if (!(await reportSubscription(subscription))) {
      return { ok: false, error: "Не удалось сохранить подписку" };
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
