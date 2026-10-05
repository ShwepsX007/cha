import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { chatMembers, chats } from "@/db/schema";

export const GENERAL_CHAT_NAME = "Общий чат";

/** The general chat is identified by its reserved name; no flags or modes. */
export function isGeneralChat(chat: { name: string | null; isGroup: boolean }): boolean {
  return chat.isGroup && chat.name === GENERAL_CHAT_NAME;
}

/**
 * Makes sure the public "Общий чат" exists and that `userId` is a member of it.
 *
 * This used to happen only during registration, so accounts created by the
 * Telegram admin bot, accounts restored after a "nuclear wipe", and any user
 * whose membership row was removed ended up with an empty chat list and no way
 * back into the public chat.
 *
 * Returns the chat id, or null when the database is unreachable.
 */
export async function ensureGeneralChatMembership(userId: number): Promise<number | null> {
  try {
    return await db.transaction(async (tx) => {
      // Serialize concurrent first-time creation so two requests cannot create
      // two public general chats.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(734729106)`);

      const [existingChat] = await tx
        .select({ id: chats.id })
        .from(chats)
        .where(
          and(
            eq(chats.name, GENERAL_CHAT_NAME),
            eq(chats.isGroup, true),
          ),
        )
        .limit(1);

      let chatId = existingChat?.id;
      if (!chatId) {
        const [created] = await tx
          .insert(chats)
          .values({
            name: GENERAL_CHAT_NAME,
            isGroup: true,
            createdBy: userId,
          })
          .returning({ id: chats.id });
        chatId = created.id;
      }

      const [membership] = await tx
        .select({ id: chatMembers.id })
        .from(chatMembers)
        .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
        .limit(1);

      if (!membership) {
        await tx.insert(chatMembers).values({ chatId, userId }).onConflictDoNothing();
      }

      return chatId;
    });
  } catch (error) {
    console.error("Could not ensure the general chat membership:", error);
    return null;
  }
}
