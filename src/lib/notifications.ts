import { db } from "@/db";
import { chatMembers, users } from "@/db/schema";
import { eq, and, ne } from "drizzle-orm";
import { sendPushToUser } from "@/lib/push";

const ONLINE_WINDOW_MS = 120_000; // user is considered "online" if seen in the last 2 minutes

interface NotifyChatMessageParams {
  chatId: number;
  senderId: number;
  textPreview: string;
  messageId: number;
  senderName: string;
}

/**
 * Best-effort fan-out of a push notification to every chat member except the
 * sender, muted members, and users who have been active in the last minute
 * (they are probably already looking at the chat). Failures are swallowed.
 */
export async function notifyChatMessage({
  chatId,
  senderId,
  textPreview,
  messageId,
  senderName,
}: NotifyChatMessageParams) {
  try {
    const recipients = await db
      .select({
        id: users.id,
        lastSeen: users.lastSeen,
        muted: chatMembers.notificationsMuted,
      })
      .from(chatMembers)
      .innerJoin(users, eq(users.id, chatMembers.userId))
      .where(
        and(
          eq(chatMembers.chatId, chatId),
          ne(chatMembers.userId, senderId),
        ),
      );

    const now = Date.now();
    await Promise.all(
      recipients.map(async (recipient) => {
        if (recipient.muted) return;
        // Skip online users — they will see the message via polling.
        if (recipient.lastSeen) {
          const last = new Date(recipient.lastSeen).getTime();
          if (Number.isFinite(last) && now - last < ONLINE_WINDOW_MS) return;
        }
        await sendPushToUser(recipient.id, {
          title: senderName,
          body: textPreview.length > 100 ? `${textPreview.slice(0, 100)}…` : textPreview,
          chatId,
          url: "/",
          messageId,
        });
      }),
    );
  } catch (err) {
    console.error("Push notification dispatch failed:", err);
  }
}

export function messagePreview(kind: string, content: string | null, fileName: string | null) {
  if (kind === "text") return content?.trim() || "";
  if (kind === "image") return `📷 ${fileName || "Фото"}`;
  if (kind === "video") return `🎬 ${fileName || "Видео"}`;
  return `📎 ${fileName || "Файл"}`;
}
