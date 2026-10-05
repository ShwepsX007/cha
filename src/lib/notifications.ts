import { db } from "@/db";
import { chatMembers, users } from "@/db/schema";
import { eq, and, ne } from "drizzle-orm";
import { sendPushToUser } from "@/lib/push";

interface NotifyChatMessageParams {
  chatId: number;
  senderId: number;
  textPreview: string;
  messageId?: number;
  senderName: string;
  url?: string;
}

export interface ChatPushFanOutResult {
  configured: boolean;
  recipients: number;
  mutedRecipients: number;
  sent: number;
  failed: number;
}

interface FanOutParams {
  chatId: number;
  senderId: number;
  title: string;
  body: string;
  url: string;
  messageId?: number;
}

/**
 * Best-effort fan-out of a push notification to every chat member except the
 * sender and muted members. Foreground suppression belongs in the service
 * worker, where the browser can tell whether a chat window is actually visible;
 * `lastSeen` is too coarse and used to drop pushes for up to a minute after a
 * user backgrounds or closes the app. Failures are swallowed.
 */
async function fanOutToChatMembers({
  chatId,
  senderId,
  title,
  body,
  url,
  messageId,
}: FanOutParams): Promise<ChatPushFanOutResult> {
  const recipients = await db
    .select({
      id: users.id,
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

  const eligibleRecipients = recipients.filter((recipient) => !recipient.muted);
  const mutedRecipients = recipients.length - eligibleRecipients.length;
  let sent = 0;
  let failed = 0;
  let configured = false;

  await Promise.all(
    eligibleRecipients.map(async (recipient) => {
      try {
        const result = await sendPushToUser(recipient.id, {
          title,
          body,
          chatId,
          url,
          messageId,
        });
        configured = configured || result.configured;
        sent += result.sent;
        failed += result.failed;
        if (result.configured && result.sent === 0) {
          console.warn("No push delivery for chat message", {
            chatId,
            recipientId: recipient.id,
            subscriptions: result.subscriptions,
            failed: result.failed,
          });
        }
      } catch (err) {
        failed += 1;
        console.error("Push recipient dispatch failed", {
          chatId,
          recipientId: recipient.id,
          errorName: err instanceof Error ? err.name : "UnknownError",
        });
      }
    }),
  );

  return { configured, recipients: eligibleRecipients.length, mutedRecipients, sent, failed };
}

export async function notifyChatMessage({
  chatId,
  senderId,
  textPreview,
  messageId,
  senderName,
  url,
}: NotifyChatMessageParams): Promise<void> {
  try {
    await fanOutToChatMembers({
      chatId,
      senderId,
      title: senderName,
      body: textPreview.length > 100 ? `${textPreview.slice(0, 100)}…` : textPreview,
      url: url || `/?chatId=${chatId}`,
      messageId,
    });
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
