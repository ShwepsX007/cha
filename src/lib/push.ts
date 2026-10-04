import webpush from "web-push";
import { eq, and } from "drizzle-orm";
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

export async function sendPushToUser(userId: number, payload: PushPayload) {
  if (!isPushConfigured()) return { sent: 0 };
  if (!configureWebPush()) return { sent: 0 };

  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));

  let sent = 0;
  const toDelete: number[] = [];
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
        const status =
          err && typeof err === "object" && "statusCode" in err
            ? (err as { statusCode?: number }).statusCode
            : undefined;
        // 404 / 410 = subscription expired or was revoked
        if (status === 404 || status === 410) {
          toDelete.push(sub.id);
        }
      }
    }),
  );

  if (toDelete.length > 0) {
    for (const id of toDelete) {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id)).catch(() => undefined);
    }
  }

  return { sent, removed: toDelete.length };
}

export async function savePushSubscription(
  userId: number,
  sub: { endpoint: string; p256dh: string; auth: string },
) {
  if (!sub.endpoint || !sub.p256dh || !sub.auth) return null;
  const existing = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.userId, userId),
        eq(pushSubscriptions.endpoint, sub.endpoint),
      ),
    );
  if (existing.length > 0) {
    const [row] = await db
      .update(pushSubscriptions)
      .set({ p256dh: sub.p256dh, auth: sub.auth })
      .where(eq(pushSubscriptions.id, existing[0].id))
      .returning({ id: pushSubscriptions.id });
    return row;
  }
  const [row] = await db
    .insert(pushSubscriptions)
    .values({ userId, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth })
    .returning({ id: pushSubscriptions.id });
  return row;
}

export async function removePushSubscription(endpoint: string) {
  if (!endpoint) return;
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
}
