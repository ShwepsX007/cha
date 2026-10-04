import webpush from "web-push";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";

export function isPushConfigured(): boolean {
  return Boolean(
    process.env.VAPID_PUBLIC_KEY
    && process.env.VAPID_PRIVATE_KEY
    && process.env.VAPID_EMAIL,
  );
}

export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || null;
}

function configureWebPush() {
  const email = process.env.VAPID_EMAIL || "mailto:admin@example.com";
  const pub = process.env.VAPID_PUBLIC_KEY || process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";
  const priv = process.env.VAPID_PRIVATE_KEY || "";
  if (!pub || !priv) return false;
  webpush.setVapidDetails(email, pub, priv);
  return true;
}

export interface PushPayload {
  title: string;
  body: string;
  chatId: number;
  url: string;
  messageId?: number;
}

export interface PushSendResult {
  configured: boolean;
  subscriptions: number;
  sent: number;
  failed: number;
  removed: number;
  failureStatusCodes: number[];
}

const emptyPushResult = (configured: boolean): PushSendResult => ({
  configured,
  subscriptions: 0,
  sent: 0,
  failed: 0,
  removed: 0,
  failureStatusCodes: [],
});

export async function sendPushToUser(userId: number, payload: PushPayload): Promise<PushSendResult> {
  if (!isPushConfigured()) return emptyPushResult(false);
  if (!configureWebPush()) return emptyPushResult(false);

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
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          json,
          { TTL: 60 * 15 },
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
