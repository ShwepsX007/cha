import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { chats, users } from "@/db/schema";
import { isGeneralChat } from "@/lib/chats";

export interface ManagedChatRow {
  id: number;
  name: string | null;
  isGroup: boolean;
  isGeneral: boolean;
  createdBy: number | null;
}

export type ChatEditAccess =
  | { ok: true; chat: ManagedChatRow; isAdmin: boolean }
  | { ok: false; response: NextResponse };

/**
 * Authorization for user-side group management (rename, avatar):
 * only the group creator or an app admin may change its look.
 *
 * The public (general) chats are admin-only even when the auto-created one
 * technically has a first-user creator — owning the container row does not
 * make a regular user the owner of the project's public space. Direct chats
 * have no editable name at all: the title is the counterpart, by design.
 */
export async function resolveChatEditAccess(
  chatId: number,
  userId: number,
): Promise<ChatEditAccess> {
  const [chat] = await db
    .select({
      id: chats.id,
      name: chats.name,
      isGroup: chats.isGroup,
      isGeneral: chats.isGeneral,
      createdBy: chats.createdBy,
    })
    .from(chats)
    .where(eq(chats.id, chatId))
    .limit(1);
  if (!chat) {
    return { ok: false, response: NextResponse.json({ error: "Чат не найден" }, { status: 404 }) };
  }

  const [requester] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId));
  const isAdmin = requester?.role === "admin";
  if (!isAdmin) {
    if (chat.createdBy !== userId) {
      return { ok: false, response: NextResponse.json({ error: "Группу может переименовывать только её создатель" }, { status: 403 }) };
    }
    if (isGeneralChat(chat)) {
      return { ok: false, response: NextResponse.json({ error: "Публичным чатом управляют администраторы" }, { status: 403 }) };
    }
    if (!chat.isGroup) {
      return { ok: false, response: NextResponse.json({ error: "Название личного чата — это имя собеседника" }, { status: 403 }) };
    }
  }

  return { ok: true, chat, isAdmin };
}
