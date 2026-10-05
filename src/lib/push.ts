import webpush from "web-push";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";

/**
 * Per-delivery deadline. A VPS that cannot reach FCM/Mozilla push would
 * otherwise keep `POST /api/messages` awaiting forever, which looks like "the
 * message never sends" rather than "push is broken".
 */
const PUSH_SEND_TIMEOUT_MS = 10_000;

function envValue(name: string): string {
  // Trailing spaces/CR from a hand-edited .env silently break base64 decoding
  // on the client, so every VAPID value is trimmed here.
  return process.env[name]?.trim() ?? "";
}

/** Which VAPID variables are missing - surfaced by /api/push/status and /api/health. */
export function missingPushEnv(): string[] {
  const missing: string[] = [];
  if (!getVapidPublicKey()) missing.push("VAPID_PUBLIC_KEY");
  if (!envValue("VAPID_PRIVATE_KEY")) missing.push("VAPID_PRIVATE_KEY");
  if (!vapidSubject()) missing.push("VAPID_EMAIL");
  return missing;
}

export function isPushConfigured(): boolean {
  return missingPushEnv().length === 0;
}

export function getVapidPublicKey(): string {
  return envValue("VAPID_PUBLIC_KEY") || envValue("NEXT_PUBLIC_VAPID_PUBLIC_KEY");
}

/**
 * `web-push` rejects anything that is not an `https:` or `mailto:` URL, and the
 * error it throws escapes before any notification is sent - which is how a bare
 * `VAPID_EMAIL=admin@example.com` disables push while the logs show nothing but
 * `errorName: Error`.
 */
export function vapidSubject(): string {
  const configured = envValue("VAPID_EMAIL");
  if (!configured) return "";
  if (/^(https?|mailto):/i.test(configured)) return configured;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(configured)) return `mailto:${configured}`;
  return "";
}

function configureWebPush(): boolean {
  const subject = vapidSubject();
  const publicKey = getVapidPublicKey();
  const privateKey = envValue("VAPID_PRIVATE_KEY");
  if (!subject || !publicKey || !privateKey) return false;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return true;
}

export interface PushPayload {
  title: string;
  body: string;
  chatId: number;
  url: string;
  messageId?: number;
  eventId?: string;
  /** Test notifications are shown even while the app is in the foreground. */
  force?: boolean;
}

export interface PushSendResult {
  configured: boolean;
  subscriptions: number;
  sent: number;
  failed: number;
  removed: number;
  failureStatusCodes: number[];
  missingEnv?: string[];
}

const emptyPushResult = (): PushSendResult => ({
  configured: false,
  subscriptions: 0,
  sent: 0,
  failed: 0,
  removed: 0,
  failureStatusCodes: [],
  missingEnv: missingPushEnv(),
});

async function sendWithTimeout(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // `Promise.race` subscribes to the delivery promise immediately, so a provider
  // error that arrives after the deadline cannot become an unhandled rejection.
  const guard = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), PUSH_SEND_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([
      webpush.sendNotification(subscription, payload, { TTL: 60 * 15 }).then(() => "sent" as const),
      guard,
    ]);
    if (outcome === "timeout") throw new Error("Push provider did not answer in time");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function sendPushToUser(userId: number, payload: PushPayload): Promise<PushSendResult> {
  if (!isPushConfigured()) return emptyPushResult();
  if (!configureWebPush()) return emptyPushResult();

  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));

  let sent = 0;
  let failed = 0;
  const toDelete: number[] = [];
  const failureStatusCodes: number[] = [];
  const json = JSON.stringify(payload);

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await sendWithTimeout(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          json,
        );
        sent += 1;
      } catch (err: unknown) {
        failed += 1;
        const status =
          err && typeof err === "object" && "statusCode" in err
            ? (err as { statusCode?: number }).statusCode
            : undefined;
        if (typeof status === "number") failureStatusCodes.push(status);
        // Keep endpoint, VAPID keys and message content out of logs.
        console.error("Web Push provider rejected a delivery", {
          userId,
          statusCode: typeof status === "number" ? status : null,
          errorName: err instanceof Error ? err.name : "UnknownError",
          errorMessage: err instanceof Error && !("statusCode" in (err as object))
            ? err.message.slice(0, 200)
            : undefined,
        });
        // 404 / 410 = subscription expired or was revoked.
        if (status === 404 || status === 410) toDelete.push(sub.id);
      }
    }),
  );

  if (toDelete.length > 0) {
    for (const id of toDelete) {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id)).catch(() => undefined);
    }
  }

  return {
    configured: true,
    subscriptions: subs.length,
    sent,
    failed,
    removed: toDelete.length,
    failureStatusCodes,
  };
}

export async function getPushSubscriptionCount(userId: number): Promise<number> {
  const rows = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));
  return rows.length;
}

export async function savePushSubscription(
  userId: number,
  sub: { endpoint: string; p256dh: string; auth: string },
) {
  if (!sub.endpoint || !sub.p256dh || !sub.auth) return null;
  // One browser endpoint is unique per origin. If a user switches accounts
  // in the same browser, atomically transfer that endpoint instead of failing
  // with a unique-constraint violation or leaving notifications on the old user.
  const [row] = await db
    .insert(pushSubscriptions)
    .values({ userId, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId, p256dh: sub.p256dh, auth: sub.auth },
    })
    .returning({ id: pushSubscriptions.id });
  return row;
}

export async function removePushSubscription(endpoint: string) {
  if (!endpoint) return;
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
}
