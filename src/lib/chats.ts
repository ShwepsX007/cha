import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { chatMembers, chats } from "@/db/schema";

/** The name a general chat gets when none exists yet. Renaming never breaks
 *  the role — membership and moderation follow the `is_general` flag. */
export const GENERAL_CHAT_NAME = "Общий чат";

/** Public "general" chats are flagged in the DB, not by their name. */
export function isGeneralChat(chat: { isGeneral?: boolean | null }): boolean {
  return Boolean(chat.isGeneral);
}

/**
 * Single source of truth for chat names (admin create/rename and the
 * group-owner rename use it): normalized, 1–100 chars, no HTML noise.
 */
export function validateChatName(input: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof input !== "string") return { ok: false, error: "Название обязательно (1–100 символов)" };
  const name = input.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 100);
  if (!name) return { ok: false, error: "Название не может быть пустым" };
  if (/<[>|]|&lt;|&gt;|&amp;/.test(name)) {
    return { ok: false, error: "Название не должно содержать HTML-спецсимволы" };
  }
  return { ok: true, name };
}

/**
 * Makes sure at least one general chat exists and that `userId` is a member
 * of every general chat ("public" means everyone is auto-joined, including
 * chats the admin created while the user was offline).
 *
 * This used to happen only during registration, so accounts created by the
 * Telegram admin bot, accounts restored after a "nuclear wipe", and any user
 * whose membership row was removed ended up with an empty chat list and no way
 * back into the public chat.
 *
 * Returns the id of the primary general chat, or null when the database is
 * unreachable.
 */
export async function ensureGeneralChatMembership(userId: number): Promise<number | null> {
  try {
    return await db.transaction(async (tx) => {
      // Serialize concurrent creation so two requests cannot create two
      // public general chats.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(734729106)`);

      const generalChats = await tx
        .select({ id: chats.id })
        .from(chats)
        .where(eq(chats.isGeneral, true));

      let primaryId = generalChats[0]?.id;
      if (primaryId === undefined) {
        const [created] = await tx
          .insert(chats)
          .values({
            name: GENERAL_CHAT_NAME,
            isGroup: true,
            isGeneral: true,
            createdBy: userId,
          })
          .returning({ id: chats.id });
        primaryId = created.id;
        generalChats.push(created);
      }

      for (const generalChat of generalChats) {
        const [membership] = await tx
          .select({ id: chatMembers.id })
          .from(chatMembers)
          .where(and(eq(chatMembers.chatId, generalChat.id), eq(chatMembers.userId, userId)))
          .limit(1);
        if (!membership) {
          await tx.insert(chatMembers).values({ chatId: generalChat.id, userId }).onConflictDoNothing();
        }
      }

      return primaryId;
    });
  } catch (error) {
    console.error("Could not ensure the general chat membership:", error);
    return null;
  }
}
