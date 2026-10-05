import { eq } from "drizzle-orm";
import { db } from "@/db";
import { chats, messages } from "@/db/schema";
import { GENERAL_CHAT_NAME, isGeneralChat } from "@/lib/chats";
import { deleteTelegramMessage } from "@/lib/telegram";

/** Hard cap on Telegram-side cleanup per request: the bot API must not turn
 *  a delete into a minutes-long crawl. The rest are pruned on the next delete. */
const TELEGRAM_CLEANUP_LIMIT = 300;

/** Best-effort removal of the Telegram copies behind the given messages. */
async function detachTelegramAttachments(rows: Array<{ messageId: number | null }>): Promise<number> {
  const messageIds = rows
    .map((row) => row.messageId)
    .filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0)
    .slice(0, TELEGRAM_CLEANUP_LIMIT);
  if (messageIds.length === 0) return 0;
  const results = await Promise.allSettled(messageIds.map((id) => deleteTelegramMessage(id)));
  return results.filter((result) => result.status === "fulfilled" && result.value).length;
}

/**
 * Delete one message of a chat for everybody: the Telegram attachment first
 * (best-effort), then the PostgreSQL row. Receipts cascade with the message;
 * replies that pointed at it keep their text and lose the jump (FK is
 * ON DELETE SET NULL).
 */
export async function deleteMessagePermanently(messageId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id, telegramMessageId: messages.telegramMessageId })
    .from(messages)
    .where(eq(messages.id, messageId));
  if (!row) return false;
  await detachTelegramAttachments([{ messageId: row.telegramMessageId }]);
  const deleted = await db
    .delete(messages)
    .where(eq(messages.id, row.id))
    .returning({ id: messages.id });
  return deleted.length > 0;
}

/**
 * Delete the same message twice from two tabs: the second delete is a no-op
 * instead of an error page — callers treat false as "already gone".
 */
export function chatDeleteGuard(chat: { name: string | null; isGroup: boolean } | null): string | null {
  if (!chat) return "Чат не найден";
  if (isGeneralChat(chat)) {
    return `«${GENERAL_CHAT_NAME}» — публичный чат проекта, его может удалить только администратор`;
  }
  return null;
}

/**
 * Delete a whole chat for everybody. Members, messages, receipts and read
 * state cascade in PostgreSQL (chat_members/chat_id and messages/chat_id are
 * ON DELETE CASCADE); Telegram attachments are removed best-effort first.
 * The general chat is refused via chatDeleteGuard by the caller.
 */
export async function deleteChatPermanently(chatId: number): Promise<{ deletedMessages: number; telegramRemoved: number } | null> {
  const [chat] = await db.select({ id: chats.id }).from(chats).where(eq(chats.id, chatId));
  if (!chat) return null;

  const attachments = await db
    .select({ messageId: messages.telegramMessageId })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .limit(TELEGRAM_CLEANUP_LIMIT);
  const telegramRemoved = await detachTelegramAttachments(attachments);

  const deletedMessages = await db
    .delete(messages)
    .where(eq(messages.chatId, chatId))
    .returning({ id: messages.id });
  await db.delete(chats).where(eq(chats.id, chatId));

  return { deletedMessages: deletedMessages.length, telegramRemoved };
}
